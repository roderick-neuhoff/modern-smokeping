package SmokepingModern::Admin;

# Everything that WRITES: SMTP / recipient settings, webhook notifications,
# raw config files (validated with `smokeping --check` before they land),
# "add target", server-side alert acknowledgements, reload, test mail/notify.
#
# Security model: Apache basic auth in front of /api (see zz-smokeping-modern.conf),
# plus a required X-Requested-With header on every mutating request so a
# cross-site form post cannot ride on cached credentials.

use strict;
use warnings;

use IPC::Open3 ();
use Symbol ();
use POSIX ();
use File::Temp ();

my $CONFIG_DIR = $ENV{SMOKEPING_CONFIG_DIR} || '/config';
my $MASTER     = $ENV{SMOKEPING_CONF}       || '/etc/smokeping/config';
my $SMOKEPING  = '/usr/sbin/smokeping';
my $SSMTP_BIN  = '/usr/sbin/ssmtp';
my $SENDMAIL   = '/app/smokeping-modern/bin/sendmail';     # msmtp wrapper
my $OAUTH_BIN  = '/app/smokeping-modern/bin/oauth-token';
my $NOTIFY_BIN = '/app/smokeping-modern/bin/notify';
my $SSMTP_CONF = "$CONFIG_DIR/ssmtp.conf";
my $MSMTP_CONF = "$CONFIG_DIR/msmtp.conf";
my $OAUTH_CFG  = "$CONFIG_DIR/modern-oauth.json";
my $NOTIFY_CFG = "$CONFIG_DIR/modern-notify.json";
my $ACKS_FILE  = "$CONFIG_DIR/modern-acks.json";
my $PATHNAMES  = "$CONFIG_DIR/pathnames";

# Microsoft device-code flow state (short-lived, one at a time)
my $DEVICE_STATE = '/tmp/spm-oauth-device.json';

my @EDITABLE = qw(Targets Alerts Probes Database General Presentation Slaves);
my %EDITABLE = map { $_ => 1 } @EDITABLE;

my $JSON;

sub handle {
    my ($method, $route, $rest, $q, $body, $json) = @_;
    $JSON = $json;
    my $sub = $rest->[0] // '';

    if ($method ne 'GET' && $method ne 'HEAD') {
        die { status => 403, error => 'missing X-Requested-With header' }
            unless ($ENV{HTTP_X_REQUESTED_WITH} || '') eq 'modern-smokeping';
    }

    return (200, me())                              if $route eq 'me';

    if ($route eq 'settings') {
        return (200, settings_get())                if $method eq 'GET';
        return (200, settings_smtp($body))          if $sub eq 'smtp'   && $method eq 'POST';
        return (200, settings_notify($body))        if $sub eq 'notify' && $method eq 'POST';
    }
    if ($route eq 'config') {
        die { status => 404, error => 'unknown config file' } unless $EDITABLE{$sub};
        return (200, config_get($sub))              if $method eq 'GET';
        return config_put($sub, $body)              if $method eq 'POST';
    }
    if ($route eq 'targets') {
        return target_add($body)                    if $sub eq 'add'    && $method eq 'POST';
        return target_remove($body)                 if $sub eq 'remove' && $method eq 'POST';
    }
    if ($route eq 'acks') {
        return (200, acks_get())                    if $method eq 'GET';
        return (200, acks_set($body))               if $method eq 'POST' && $sub ne 'delete';
        return (200, acks_delete($body))            if ($method eq 'DELETE') || $sub eq 'delete';
    }
    if ($route eq 'test') {
        return (200, test_mail($body))              if $sub eq 'mail'   && $method eq 'POST';
        return (200, test_notify($body))            if $sub eq 'notify' && $method eq 'POST';
    }
    if ($route eq 'oauth') {
        my $act = $rest->[1] // '';
        return (200, oauth_device_start($body))     if $sub eq 'microsoft' && $act eq 'start' && $method eq 'POST';
        return (200, oauth_device_poll($body))      if $sub eq 'microsoft' && $act eq 'poll'  && $method eq 'POST';
        return (200, oauth_authorize($body))        if $sub eq 'authorize' && $method eq 'POST';
        return (200, oauth_paste($body))            if $sub eq 'paste' && $method eq 'POST';
        return (200, oauth_status())                if $sub eq 'status';
        return oauth_callback($q)                   if $sub eq 'callback';      # GET from the provider, returns HTML
        return (200, oauth_token_check())           if $sub eq 'check' && $method eq 'POST';
        return (200, oauth_forget())                if $sub eq 'forget' && $method eq 'POST';
    }
    return (200, reload())                          if $route eq 'reload' && $method eq 'POST';

    die { status => 405, error => "$method $route/$sub not supported" };
}

# ---------------------------------------------------------------------------

sub me {
    return {
        user     => $ENV{REMOTE_USER} // undef,
        authed   => ($ENV{REMOTE_USER} ? \1 : \0),
        canWrite => \1,
    };
}

# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

sub _slurp {
    my $f = shift;
    open my $fh, '<', $f or return undef;
    local $/;
    my $s = <$fh>;
    close $fh;
    return $s;
}

sub _spew {
    my ($f, $s, $mode) = @_;
    my $tmp = "$f.tmp.$$";
    open my $fh, '>', $tmp or die { status => 500, error => "cannot write $f: $!" };
    print $fh $s;
    close $fh;
    chmod $mode, $tmp if $mode;
    rename $tmp, $f or die { status => 500, error => "cannot replace $f: $!" };
}

# Mail is sent through msmtp (/config/msmtp.conf). We keep reading a legacy
# ssmtp.conf so an existing install shows its old server/user on first visit.
sub _read_kv {
    my ($file, $sep) = @_;
    my %c;
    for my $line (split /\n/, _slurp($file) // '') {
        next if $line =~ /^\s*#/;
        my ($k, $v) = $sep eq '=' ? split(/=/, $line, 2) : split(/\s+/, ($line =~ s/^\s+//r), 2);
        next unless defined $k && defined $v;
        $k =~ s/^\s+|\s+$//g; $v =~ s/^\s+|\s+$//g;
        $c{$k} = $v;
    }
    return \%c;
}

sub _read_oauth {
    my $d = eval { $JSON->decode(_slurp($OAUTH_CFG) // '{}') } || {};
    return $d;
}

sub _read_ssmtp {
    my $m = _read_kv($MSMTP_CONF, ' ');
    if (%$m && $m->{host}) {
        my $o = _read_oauth();
        my $method = ($m->{auth} // '') eq 'xoauth2' ? 'oauth-' . ($o->{provider} || 'google') : 'password';
        return {
            host      => $m->{host} // '',
            port      => ($m->{port} // 587) + 0,
            starttls  => (($m->{tls_starttls} // 'on') eq 'on' ? \1 : \0),
            tls       => (($m->{tls} // 'on') eq 'on' && ($m->{tls_starttls} // 'on') eq 'off' ? \1 : \0),
            authUser  => $m->{user} // '',
            passSet   => (length($m->{password} // '') ? \1 : \0),
            root      => $m->{from} // '',
            hostname  => '',
            authMethod => $method,
            engine    => 'msmtp',
            _pass     => $m->{password} // '',
        };
    }
    # legacy ssmtp.conf (pre-OAuth installs)
    my $c = _read_kv($SSMTP_CONF, '=');
    my ($host, $port) = ($c->{mailhub} // '') =~ /^([^:]*)(?::(\d+))?$/;
    return {
        host      => $host // '',
        port      => ($port // 587) + 0,
        starttls  => (($c->{UseSTARTTLS} // 'no') =~ /yes/i ? \1 : \0),
        tls       => (($c->{UseTLS} // 'no') =~ /yes/i ? \1 : \0),
        authUser  => $c->{AuthUser} // '',
        passSet   => (length($c->{AuthPass} // '') ? \1 : \0),
        root      => $c->{root} // '',
        hostname  => $c->{hostname} // '',
        authMethod => 'password',
        engine    => 'ssmtp',
        _pass     => $c->{AuthPass} // '',
    };
}

sub _write_msmtp { _write_msmtp_to($MSMTP_CONF, @_) }

sub _write_msmtp_to {
    my ($path, $h) = @_;      # host port starttls tls user pass from method
    my $starttls = $h->{tls} ? 'off' : ($h->{starttls} ? 'on' : 'off');
    my $tls      = ($h->{tls} || $h->{starttls}) ? 'on' : 'off';
    my @l = (
        '# managed by modern-smokeping - edit via Settings -> E-mail',
        'defaults',
        "tls $tls",
        "tls_starttls $starttls",
        'tls_trust_file /etc/ssl/certs/ca-certificates.crt',
        "logfile $CONFIG_DIR/log/msmtp.log",
        'timeout 30',
        '',
        'account default',
        "host $h->{host}",
        "port $h->{port}",
        "from $h->{from}",
    );
    if ($h->{method} =~ /^oauth/) {
        push @l, 'auth xoauth2', "user $h->{user}", "passwordeval $OAUTH_BIN";
    } elsif (length($h->{user} // '')) {
        push @l, 'auth on', "user $h->{user}", 'password ' . ($h->{pass} // '');
    } else {
        push @l, 'auth off';
    }
    _spew($path, join("\n", @l) . "\n", 0600);
}

# point SmokePing at the msmtp wrapper (pathnames: sendmail = ...)
sub _ensure_sendmail_path {
    my $s = _slurp($PATHNAMES) // '';
    return 0 if $s =~ /^\s*sendmail\s*=\s*\Q$SENDMAIL\E\s*$/m;
    if ($s =~ /^\s*sendmail\s*=/m) { $s =~ s/^\s*sendmail\s*=.*$/sendmail = $SENDMAIL/m }
    else                            { $s = "sendmail = $SENDMAIL\n$s" }
    _spew($PATHNAMES, $s, 0644);
    return 1;
}

# "to = ..." / "from = ..." at the top of the Alerts file (before the first +alert)
sub _read_alert_header {
    my $s = _slurp("$CONFIG_DIR/Alerts") // '';
    my ($head) = split /^\s*\+/m, $s, 2;
    my ($to)   = $head =~ /^\s*to\s*=\s*(.*?)\s*$/m;
    my ($from) = $head =~ /^\s*from\s*=\s*(.*?)\s*$/m;
    my @addr = map { s/^\s+|\s+$//gr } split /,/, ($to // '');
    return {
        emails   => [ grep { length && !/^\|/ } @addr ],
        pipes    => [ grep { /^\|/ } @addr ],
        from     => $from // '',
        webhooks => ((grep { $_ eq "|$NOTIFY_BIN" } @addr) ? \1 : \0),
    };
}

sub _write_alert_header {
    my ($emails, $from, $webhooks) = @_;
    my $file = "$CONFIG_DIR/Alerts";
    my $s = _slurp($file) // "*** Alerts ***\n";
    my @to = (@$emails, ($webhooks ? "|$NOTIFY_BIN" : ()));
    @to = ('root@localhost') unless @to;        # SmokePing requires a non-empty "to"
    my $to_line   = 'to = ' . join(',', @to);
    my $from_line = 'from = ' . ($from || 'smokeping@localhost');

    # keep everything from the first "+alert" on; rebuild the header
    my ($head, $rest) = split /(?=^\s*\+)/m, $s, 2;
    $rest //= '';
    my @keep = grep { !/^\s*(to|from)\s*=/ && !/^\s*\*\*\*\s*Alerts/ } split /\n/, $head;
    my $new = join("\n", '*** Alerts ***', $to_line, $from_line, grep { length } @keep) . "\n\n" . $rest;
    _spew($file, $new, 0644);
}

sub _read_notify {
    my $d = eval { $JSON->decode(_slurp($NOTIFY_CFG) // '{}') } || {};
    return $d;
}

sub settings_get {
    my $smtp = _read_ssmtp();
    delete $smtp->{_pass};
    my $o = _read_oauth();
    $smtp->{oauth} = {
        provider        => $o->{provider} // '',
        clientId        => $o->{clientId} // '',
        clientSecretSet => (length($o->{clientSecret} // '') ? \1 : \0),
        refreshTokenSet => (length($o->{refreshToken} // '') ? \1 : \0),
        configured      => ((length($o->{refreshToken} // '') || (($o->{provider} // '') eq 'microsoft-app' && length($o->{clientSecret} // ''))) ? \1 : \0),
        tenant          => $o->{tenant} // 'common',
        account         => $o->{account} // '',
        connectedAt     => $o->{connectedAt},
    };
    my $hdr = _read_alert_header();
    my $notify = _read_notify();
    return {
        smtp     => $smtp,
        alerts   => { to => $hdr->{emails}, from => $hdr->{from}, webhooks => $hdr->{webhooks}, extra => $hdr->{pipes} },
        notify   => $notify,
        notifyBin => $NOTIFY_BIN,
        user     => $ENV{REMOTE_USER},
        editable => \@EDITABLE,
    };
}

sub settings_smtp {
    my $b = shift || {};
    my $cur = _read_ssmtp();
    my $method = $b->{authMethod} // 'password';
    die { status => 422, error => 'authMethod must be password, oauth-google, oauth-microsoft or oauth-microsoft-app' }
        unless $method =~ /^(password|oauth-google|oauth-microsoft|oauth-microsoft-app)$/;
    my $host = $b->{host} // '';
    $host =~ s/\s//g;
    $host ||= $method eq 'oauth-google' ? 'smtp.gmail.com' : $method =~ /^oauth-microsoft/ ? 'smtp.office365.com' : '';
    die { status => 422, error => 'mail server host is required' } unless length $host;
    my $port = int($b->{port} || 587);
    my $pass = defined $b->{authPass} && length $b->{authPass} ? $b->{authPass} : $cur->{_pass};
    my $from = $b->{from} || $cur->{root} || 'smokeping@localhost';
    die { status => 422, error => 'from must be an e-mail address' } unless $from =~ /^[^\s@]+@[^\s@]+$/;
    my $user = $b->{authUser} // '';
    $user =~ s/\s//g;
    my @emails = grep { length } map { s/\s//gr } @{ $b->{to} || [] };
    for (@emails) { die { status => 422, error => "invalid recipient '$_'" } unless /^[^\s@]+@[^\s@]+$/ }

    if ($method =~ /^oauth-([\w-]+)$/) {
        my $provider = $1;
        my $o = _read_oauth();
        my $oi = $b->{oauth} || {};
        # keep stored secrets when the form sends them blank; switching provider clears them
        my $same = ($o->{provider} // '') eq $provider;
        my %new = (
            provider     => $provider,
            clientId     => (length($oi->{clientId} // '') ? $oi->{clientId} : ($same ? $o->{clientId} : '')),
            clientSecret => (length($oi->{clientSecret} // '') ? $oi->{clientSecret} : ($same ? $o->{clientSecret} : '')),
            refreshToken => (length($oi->{refreshToken} // '') ? $oi->{refreshToken} : ($same ? $o->{refreshToken} : '')),
            tenant       => ($oi->{tenant} || ($same ? $o->{tenant} : '') || 'common'),
            account      => ($user || ($same ? $o->{account} : '') || ''),
            connectedAt  => ($same ? $o->{connectedAt} : undef),
        );
        for (qw(clientId clientSecret refreshToken tenant account)) { $new{$_} =~ s/[\r\n]//g if defined $new{$_} }
        die { status => 422, error => 'OAuth client ID is required' } unless length $new{clientId};
        if ($provider eq 'microsoft-app') {
            # app-only: secret + a real tenant are the whole credential; nothing to "connect"
            die { status => 422, error => 'client secret is required for app-only (client credentials) auth' } unless length $new{clientSecret};
            die { status => 422, error => 'tenant must be your tenant ID or domain, not "common", for app-only auth' }
                if $new{tenant} =~ /^(common|organizations|consumers)$/i;
            $new{refreshToken} = '';
            $new{connectedAt} //= time;
        } else {
            $new{connectedAt} //= time if $new{refreshToken};
        }
        $user ||= $new{account};
        die { status => 422, error => 'mailbox address (user) is required for OAuth2' } unless $user =~ /^[^\s@]+@[^\s@]+$/;
        $new{account} = $user;
        _spew($OAUTH_CFG, $JSON->canonical->encode(\%new) . "\n", 0600);
        unlink '/tmp/spm-oauth-token.json';
    }

    _write_msmtp({ host => $host, port => $port, starttls => $b->{starttls} ? 1 : 0, tls => $b->{tls} ? 1 : 0,
                   user => $user, pass => $pass, from => $from, method => $method });
    my $switched = _ensure_sendmail_path();
    _write_alert_header(\@emails, $from, $b->{webhooks} ? 1 : 0);

    my $chk = _check_config();
    my $rl = _passed($chk) ? _hup() : { ok => \0, note => 'not reloaded - config check failed' };
    return { ok => \1, check => $chk, reload => $rl, sendmailSwitched => ($switched ? \1 : \0), settings => settings_get() };
}

# ---------------------------------------------------------------------------
# OAuth2 helpers (Microsoft device-code sign-in; Google = pasted refresh token)
# ---------------------------------------------------------------------------

sub _curl_form_json {
    my ($url, %form) = @_;
    my @cmd = ('/usr/bin/curl', '-sS', '-m', '25', '-X', 'POST', $url);
    for my $k (sort keys %form) { push @cmd, '--data-urlencode', "$k=$form{$k}" }
    my ($out, $rc) = _capture(30, @cmd);
    die { status => 502, error => "token endpoint unreachable (curl rc=$rc)" } if $rc;
    my $d = eval { $JSON->decode($out) };
    die { status => 502, error => 'token endpoint returned non-JSON: ' . substr($out, 0, 200) } unless $d;
    return $d;
}

# turn Entra's AADSTS codes into something a person can act on
sub _ms_hint {
    my $d = shift;
    my $desc = $d->{error_description} // '';
    my ($code) = $desc =~ /(AADSTS\d+)/;
    my %hint = (
        AADSTS7000218 => 'Your app registration is a confidential client. Either set Entra ID -> App -> Authentication -> "Allow public client flows" = Yes (recommended), or paste a client secret from "Certificates & secrets" into the Client secret field, then Connect again.',
        AADSTS700016  => 'Application not found in this tenant - check the client ID, and use your tenant ID instead of "common" for a single-tenant app.',
        AADSTS65001   => 'Consent is missing - an admin may need to grant the SMTP.Send permission for the app, or sign in with an account allowed to consent.',
        AADSTS700038  => 'That is not a valid application (client) ID.',
        AADSTS50126   => 'Wrong user name or password during sign-in.',
        AADSTS50076   => 'Multi-factor authentication was required and not completed - sign in again and finish MFA.',
        AADSTS70016   => 'The sign-in code expired before it was used - click Connect again.',
        AADSTS7000215 => 'The client secret is wrong or expired.',
    );
    my $h = $code && $hint{$code} ? " -> $hint{$code}" : '';
    return "$d->{error}: " . ($desc =~ s/\s*Trace ID:.*$//sr) . $h;
}

sub oauth_device_start {
    my $b = shift || {};
    my $client = $b->{clientId} // '';
    $client =~ s/\s//g;
    die { status => 422, error => 'Microsoft application (client) ID is required' } unless length $client;
    my $tenant = $b->{tenant} || 'common';
    $tenant =~ s/[^A-Za-z0-9.-]//g;
    # secret: from the form, else the one already stored for this same app
    my $secret = $b->{clientSecret} // '';
    if (!length $secret) {
        my $o = _read_oauth();
        $secret = $o->{clientSecret} // '' if ($o->{provider} // '') eq 'microsoft' && ($o->{clientId} // '') eq $client;
    }
    my %form = (client_id => $client, scope => 'https://outlook.office365.com/SMTP.Send offline_access openid email');
    $form{client_secret} = $secret if length $secret;   # confidential apps need it here too
    my $d = _curl_form_json("https://login.microsoftonline.com/$tenant/oauth2/v2.0/devicecode", %form);
    die { status => 422, error => _ms_hint($d) } if $d->{error};
    _spew($DEVICE_STATE, $JSON->encode({ clientId => $client, clientSecret => $secret, tenant => $tenant,
        deviceCode => $d->{device_code}, interval => ($d->{interval} || 5), expires => time + ($d->{expires_in} || 900) }), 0600);
    return { ok => \1, userCode => $d->{user_code}, verificationUri => $d->{verification_uri},
             message => $d->{message}, expiresIn => $d->{expires_in}, interval => ($d->{interval} || 5) };
}

sub oauth_device_poll {
    my $st = eval { $JSON->decode(_slurp($DEVICE_STATE) // '') } or die { status => 409, error => 'no sign-in in progress' };
    die { status => 410, error => 'sign-in expired - start again' } if time > $st->{expires};
    my %form = (client_id => $st->{clientId}, grant_type => 'urn:ietf:params:oauth:grant-type:device_code', device_code => $st->{deviceCode});
    $form{client_secret} = $st->{clientSecret} if length($st->{clientSecret} // '');
    my $d = _curl_form_json("https://login.microsoftonline.com/$st->{tenant}/oauth2/v2.0/token", %form);
    if ($d->{error}) {
        return { ok => \0, pending => \1, status => $d->{error} } if $d->{error} =~ /^(authorization_pending|slow_down)$/;
        unlink $DEVICE_STATE;
        die { status => 422, error => _ms_hint($d) };
    }
    die { status => 502, error => 'no refresh_token returned - is offline_access consented?' } unless $d->{refresh_token};
    # mailbox address from the id_token (preferred_username / email)
    my $account = '';
    if ($d->{id_token} && (my ($mid) = (split /\./, $d->{id_token})[1])) {
        $mid =~ tr{-_}{+/}; $mid .= '=' x ((4 - length($mid) % 4) % 4);
        require MIME::Base64;
        my $claims = eval { $JSON->decode(MIME::Base64::decode_base64($mid)) } || {};
        $account = $claims->{preferred_username} || $claims->{email} || '';
    }
    my $o = _read_oauth();
    my %new = (provider => 'microsoft', clientId => $st->{clientId}, clientSecret => ($st->{clientSecret} // ''),
               refreshToken => $d->{refresh_token}, tenant => $st->{tenant}, account => ($account || $o->{account} || ''),
               connectedAt => time);
    _spew($OAUTH_CFG, $JSON->canonical->encode(\%new) . "\n", 0600);
    unlink $DEVICE_STATE, '/tmp/spm-oauth-token.json';
    return { ok => \1, account => $new{account}, connectedAt => $new{connectedAt} };
}

# ---------------------------------------------------------------------------
# Authorization-code + PKCE ("Sign in with Microsoft/Google"): the provider
# shows its own login + permissions screen, then returns a code either to our
# https callback (publicBase set) or to the provider's hosted landing page,
# whose address the user pastes back.
# ---------------------------------------------------------------------------
my $AUTHCODE_STATE = '/tmp/spm-oauth-authcode.json';
my $NATIVE_LANDING = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

sub _b64url { my $s = MIME::Base64::encode_base64($_[0], ''); $s =~ tr{+/}{-_}; $s =~ s/=+$//; $s }

sub _rand_str {
    my $n = shift || 48;
    open my $r, '<', '/dev/urandom' or die { status => 500, error => 'no urandom' };
    read $r, my $buf, $n; close $r;
    return _b64url($buf);
}

sub _redirect_uri {
    my $base = shift // '';
    $base =~ s{/+$}{};
    return length $base ? "$base/api/oauth/callback" : $NATIVE_LANDING;
}

sub oauth_authorize {
    my $b = shift || {};
    require MIME::Base64; require Digest::SHA;
    my $provider = $b->{provider} // 'microsoft';
    die { status => 422, error => 'provider must be microsoft or google' } unless $provider =~ /^(microsoft|google)$/;
    my $client = ($b->{clientId} // '') =~ s/\s//gr;
    die { status => 422, error => 'client ID is required' } unless length $client;
    my $base = ($b->{publicBase} // '') =~ s/\s//gr;
    die { status => 422, error => 'public URL must start with https:// (Microsoft/Google only accept https redirect URIs)' }
        if length $base && $base !~ m{^https://};
    die { status => 422, error => 'Google needs the public https URL of this SmokePing as the redirect (no hosted landing page exists)' }
        if $provider eq 'google' && !length $base;

    my $o = _read_oauth();
    my $secret = length($b->{clientSecret} // '') ? $b->{clientSecret}
               : (($o->{provider} // '') eq $provider && ($o->{clientId} // '') eq $client) ? ($o->{clientSecret} // '') : '';
    my $tenant = ($b->{tenant} || 'common') =~ s/[^A-Za-z0-9.-]//gr;
    my $verifier  = _rand_str(64);
    my $challenge = _b64url(Digest::SHA::sha256($verifier));
    my $state     = _rand_str(24);
    my $redirect  = _redirect_uri($base);

    my ($url, %p);
    if ($provider eq 'microsoft') {
        $url = "https://login.microsoftonline.com/$tenant/oauth2/v2.0/authorize";
        %p = (client_id => $client, response_type => 'code', redirect_uri => $redirect, response_mode => 'query',
              scope => 'openid email offline_access https://outlook.office365.com/SMTP.Send',
              state => $state, code_challenge => $challenge, code_challenge_method => 'S256', prompt => 'consent');
    } else {
        $url = 'https://accounts.google.com/o/oauth2/v2/auth';
        %p = (client_id => $client, response_type => 'code', redirect_uri => $redirect,
              scope => 'https://mail.google.com/ openid email', access_type => 'offline', prompt => 'consent',
              state => $state, code_challenge => $challenge, code_challenge_method => 'S256');
    }
    my $qs = join '&', map { $_ . '=' . _urlenc($p{$_}) } sort keys %p;
    _spew($AUTHCODE_STATE, $JSON->encode({ provider => $provider, clientId => $client, clientSecret => $secret, tenant => $tenant,
        verifier => $verifier, state => $state, redirect => $redirect, publicBase => $base, started => time, expires => time + 900 }), 0600);
    return { ok => \1, url => "$url?$qs", redirectUri => $redirect, viaCallback => (length $base ? \1 : \0), state => $state };
}

sub _urlenc { my $s = shift // ''; $s =~ s/([^A-Za-z0-9_.~-])/sprintf('%%%02X', ord $1)/ge; $s }

# turn an authorization code into tokens and store them
sub _authcode_exchange {
    my ($st, $code) = @_;
    my ($url, %form);
    if ($st->{provider} eq 'microsoft') {
        $url  = "https://login.microsoftonline.com/$st->{tenant}/oauth2/v2.0/token";
        %form = (client_id => $st->{clientId}, grant_type => 'authorization_code', code => $code,
                 redirect_uri => $st->{redirect}, code_verifier => $st->{verifier},
                 scope => 'openid email offline_access https://outlook.office365.com/SMTP.Send');
    } else {
        $url  = 'https://oauth2.googleapis.com/token';
        %form = (client_id => $st->{clientId}, grant_type => 'authorization_code', code => $code,
                 redirect_uri => $st->{redirect}, code_verifier => $st->{verifier});
    }
    $form{client_secret} = $st->{clientSecret} if length($st->{clientSecret} // '');
    my $d = _curl_form_json($url, %form);
    if ($d->{error}) {
        die { status => 422, error => ($st->{provider} eq 'microsoft' ? _ms_hint($d) : "$d->{error}: " . ($d->{error_description} // '')) };
    }
    die { status => 502, error => 'no refresh_token returned - the consent screen must include "maintain access" / offline access' }
        unless $d->{refresh_token};
    my $account = '';
    if ($d->{id_token} && (my ($mid) = (split /\./, $d->{id_token})[1])) {
        $mid =~ tr{-_}{+/}; $mid .= '=' x ((4 - length($mid) % 4) % 4);
        require MIME::Base64;
        my $claims = eval { $JSON->decode(MIME::Base64::decode_base64($mid)) } || {};
        $account = $claims->{preferred_username} || $claims->{email} || '';
    }
    my $o = _read_oauth();
    my %new = (provider => $st->{provider}, clientId => $st->{clientId}, clientSecret => ($st->{clientSecret} // ''),
               refreshToken => $d->{refresh_token}, tenant => ($st->{tenant} // 'common'),
               account => ($account || $o->{account} || ''), connectedAt => time, publicBase => ($st->{publicBase} // ''));
    _spew($OAUTH_CFG, $JSON->canonical->encode(\%new) . "\n", 0600);
    unlink $AUTHCODE_STATE, '/tmp/spm-oauth-token.json';
    return \%new;
}

sub _authcode_state {
    my $st = eval { $JSON->decode(_slurp($AUTHCODE_STATE) // '') } or die { status => 409, error => 'no sign-in in progress - click Sign in first' };
    die { status => 410, error => 'sign-in expired - start again' } if time > $st->{expires};
    return $st;
}

# GET /api/oauth/callback?code=&state=   (from the provider; no password - the state is the proof)
sub oauth_callback {
    my $q = shift || {};
    my $html = sub {
        my ($ok, $title, $body) = @_;
        my $esc = sub { my $s = shift // ''; $s =~ s/&/&amp;/g; $s =~ s/</&lt;/g; $s =~ s/>/&gt;/g; $s };
        return (200, { html => '<!doctype html><meta charset="utf-8"><title>' . $esc->($title) . '</title>'
            . '<body style="font:15px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0f141b;color:#e4e9f0">'
            . '<div style="max-width:520px;padding:28px;border-radius:12px;background:#171e28;border:1px solid ' . ($ok ? '#1f9d57' : '#d93a3a') . '">'
            . '<h2 style="margin:0 0 10px">' . $esc->($title) . '</h2><p>' . $esc->($body) . '</p>'
            . ($ok ? '<p>You can close this tab and go back to SmokePing → Settings → E-mail, then click <b>Save mail settings</b>.</p>' : '')
            . '</div></body>' });
    };
    return $html->(0, 'Sign-in failed', ($q->{error} // 'error') . ': ' . ($q->{error_description} // '')) if $q->{error};
    my $st = eval { _authcode_state() };
    return $html->(0, 'No sign-in in progress', ref $@ ? $@->{error} : "$@") unless $st;
    return $html->(0, 'State mismatch', 'This response does not belong to the sign-in that was started. Start again from Settings.')
        unless ($q->{state} // '') eq $st->{state};
    my $new = eval { _authcode_exchange($st, $q->{code} // '') };
    return $html->(0, 'Token exchange failed', ref $@ ? $@->{error} : "$@") unless $new;
    return $html->(1, 'Connected', 'Signed in' . ($new->{account} ? " as $new->{account}" : '') . '. Permissions granted.');
}

# fallback: the user pastes the address of the landing page (…?code=…&state=…)
sub oauth_paste {
    my $b = shift || {};
    my $u = $b->{url} // '';
    my ($code)  = $u =~ /[?&#]code=([^&#\s]+)/;
    my ($state) = $u =~ /[?&#]state=([^&#\s]+)/;
    my ($err)   = $u =~ /[?&#]error=([^&#\s]+)/;
    die { status => 422, error => "the provider reported: $err" } if $err && !$code;
    die { status => 422, error => 'no code= found in that address - paste the full URL of the page you landed on' } unless $code;
    $code =~ s/%([0-9A-Fa-f]{2})/chr hex $1/ge;
    my $st = _authcode_state();
    die { status => 422, error => 'state mismatch - start the sign-in again and paste the new address' } unless ($state // '') eq $st->{state};
    my $new = _authcode_exchange($st, $code);
    return { ok => \1, account => $new->{account}, connectedAt => $new->{connectedAt} };
}

sub oauth_status {
    my $o = _read_oauth();
    my $pending = -f $AUTHCODE_STATE ? 1 : 0;
    return { connected => (length($o->{refreshToken} // '') ? \1 : \0), account => $o->{account}, provider => $o->{provider},
             connectedAt => $o->{connectedAt}, pending => ($pending ? \1 : \0), publicBase => $o->{publicBase} };
}

# exchange the stored credentials for a token once, then read what the token
# actually grants - this is what Exchange looks at when it says 535 5.7.3
sub oauth_token_check {
    unlink '/tmp/spm-oauth-token.json';                 # force a fresh exchange
    my ($out, $rc) = _capture(40, $OAUTH_BIN);
    my $token = $rc == 0 ? ($out =~ s/\s+//gr) : '';
    return { ok => \0, rc => $rc, output => ($out =~ s/\s+$//r) } unless $rc == 0 && length $token;

    my $o = _read_oauth();
    my @lines = ('access token obtained (' . length($token) . ' chars)');
    my $claims;
    if ($token =~ /^[\w-]+\.([\w-]+)\.[\w-]+$/) {        # a JWT (Microsoft); Google tokens are opaque
        my $mid = $1; $mid =~ tr{-_}{+/}; $mid .= '=' x ((4 - length($mid) % 4) % 4);
        require MIME::Base64;
        $claims = eval { $JSON->decode(MIME::Base64::decode_base64($mid)) };
    }
    my $verdict;
    if ($claims) {
        my @roles = ref $claims->{roles} eq 'ARRAY' ? @{ $claims->{roles} } : ();
        my $scp = $claims->{scp} // '';
        push @lines, "audience : " . ($claims->{aud} // '?'),
                     "tenant   : " . ($claims->{tid} // '?'),
                     "app id   : " . ($claims->{appid} // $claims->{azp} // '?'),
                     "roles    : " . (@roles ? join(', ', @roles) : '(none)'),
                     "scopes   : " . ($scp || '(none)'),
                     "expires  : " . ($claims->{exp} ? scalar localtime($claims->{exp}) : '?');
        my $aud_ok = ($claims->{aud} // '') =~ m{outlook\.office365\.com|outlook\.office\.com|00000002-0000-0ff1-ce00-000000000000};
        if (($o->{provider} // '') eq 'microsoft-app') {
            if (!grep { /^SMTP\.SendAsApp$/ } @roles) {
                $verdict = "PROBLEM: the token has no SMTP.SendAsApp role. In Entra ID -> App -> API permissions add "
                         . "'Office 365 Exchange Online' -> Application permissions -> SMTP.SendAsApp, then consent: "
                         . "click 'Request admin consent' here (or 'Grant admin consent' in the portal) and run Check token again. "
                         . "(A delegated SMTP.Send permission does not count for app-only.)";
            } elsif (!$aud_ok) {
                $verdict = "PROBLEM: token audience is not Exchange Online (" . ($claims->{aud} // '?') . ").";
            } else {
                $verdict = "Token is correct for app-only SMTP. If Exchange still answers 535 5.7.3, the remaining causes are on the Exchange side: "
                         . "(1) the app was not granted the mailbox - run New-ServicePrincipal + Add-MailboxPermission for " . ($o->{account} || 'the mailbox') . "; "
                         . "(2) SMTP AUTH is disabled - Set-CASMailbox -Identity " . ($o->{account} || '<mailbox>') . " -SmtpClientAuthenticationDisabled \$false "
                         . "(and Get-TransportConfig | fl SmtpClientAuthenticationDisabled for the org default); "
                         . "(3) the 'Send as mailbox' address differs from the mailbox that was granted. Changes can take a few minutes to apply.";
            }
        } else {
            $verdict = $scp =~ /SMTP\.Send/ ? 'Token carries the SMTP.Send scope - good.'
                     : 'PROBLEM: token has no SMTP.Send scope - re-connect and consent to SMTP.Send.';
        }
    } else {
        $verdict = 'Token obtained (opaque, not a JWT) - use "Test these settings" to verify sending.';
    }
    push @lines, '', $verdict;
    return { ok => ($verdict =~ /^PROBLEM/ ? \0 : \1), rc => 0, output => join("\n", @lines),
             claims => ($claims ? { aud => $claims->{aud}, tid => $claims->{tid}, appid => ($claims->{appid} // $claims->{azp}),
                                    roles => $claims->{roles}, scp => $claims->{scp} } : undef) };
}

sub oauth_forget {
    unlink $OAUTH_CFG, $DEVICE_STATE, '/tmp/spm-oauth-token.json';
    return { ok => \1 };
}

sub settings_notify {
    my $b = shift || {};
    my %allowed = map { $_ => 1 } qw(discord telegram ntfy gotify webhook slack);
    my %out;
    for my $k (keys %$b) {
        next unless $allowed{$k} && ref $b->{$k} eq 'HASH';
        my %c = %{ $b->{$k} };
        $c{enabled} = $c{enabled} ? \1 : \0;
        $out{$k} = \%c;
    }
    _spew($NOTIFY_CFG, $JSON->pretty->canonical->encode(\%out) . "\n", 0640);
    return { ok => \1, notify => \%out };
}

# ---------------------------------------------------------------------------
# config files
# ---------------------------------------------------------------------------

sub config_get {
    my $name = shift;
    my $f = "$CONFIG_DIR/$name";
    return { name => $name, text => (_slurp($f) // ''), exists => (-f $f ? \1 : \0), mtime => (-f $f ? (stat $f)[9] : undef) };
}

# validate the candidate file by pointing a temporary master config at it
sub _check_candidate {
    my ($name, $text) = @_;
    my $dir = File::Temp::tempdir('spm-check-XXXXXX', TMPDIR => 1, CLEANUP => 1);
    my $cand = "$dir/$name";
    _spew($cand, $text);
    my $master = _slurp($MASTER) // '';
    my $real = "$CONFIG_DIR/$name";
    $master =~ s{^(\s*\@include\s+)\Q$real\E\s*$}{$1$cand}m
        or $master .= "\@include $cand\n";
    _spew("$dir/config", $master);
    return _run_check("$dir/config");
}

sub _run_check {
    my $conf = shift || $MASTER;
    my ($out, $rc) = _capture(30, $SMOKEPING, "--config=$conf", '--check');
    $out =~ s/\s+$//;
    return { ok => ($rc == 0 ? \1 : \0), rc => $rc, output => $out };
}

# NB: $chk->{ok} is a JSON boolean *reference* (\1 / \0) - both are TRUE in
# Perl. Always test the exit code, never the ok field.
sub _passed { my $chk = shift; return defined $chk->{rc} && $chk->{rc} == 0 }

sub _check_config { _run_check($MASTER) }

sub config_put {
    my ($name, $b) = @_;
    my $text = $b && $b->{text};
    die { status => 422, error => 'text is required' } unless defined $text;
    $text =~ s/\r\n?/\n/g;
    $text .= "\n" unless $text =~ /\n\z/;
    my $chk = _check_candidate($name, $text);
    return (422, { ok => \0, check => $chk, error => 'config check failed - nothing was written' }) unless _passed($chk);
    my $f = "$CONFIG_DIR/$name";
    _spew("$f.bak", _slurp($f) // '') if -f $f;
    _spew($f, $text, 0644);
    my $rl = _hup();
    return (200, { ok => \1, check => $chk, reload => $rl, name => $name });
}

sub target_add {
    my $b = shift || {};
    my $key = $b->{key} // '';
    $key =~ s/[^A-Za-z0-9_-]//g;
    die { status => 422, error => 'key must be letters/digits/_/-' } unless length $key;
    my $host = $b->{host} // '';
    $host =~ s/\s//g;
    die { status => 422, error => 'host is required' } unless length $host;
    die { status => 422, error => 'host looks unsafe' } if $host =~ /[^A-Za-z0-9.:_-]/;
    my $parent = $b->{parent} // '';          # e.g. "/WAN" or "" for top level
    $parent =~ s{^/}{};
    my @segs = grep { length } split m{/}, $parent;
    my $depth = @segs + 1;

    my $file = "$CONFIG_DIR/Targets";
    my $s = _slurp($file) // "*** Targets ***\nprobe = FPing\nmenu = Top\ntitle = Network Latency\n";

    my @lines = split /\n/, $s;
    my $insert_at = scalar @lines;              # default: append at end (top-level target)
    if (@segs) {
        # find the parent section header, then the end of its subtree
        my $want = ('+' x scalar @segs) . ' ' . $segs[-1];
        my ($start) = grep { $lines[$_] =~ /^\s*\Q$want\E\s*$/ || $lines[$_] =~ /^\s*\+{@{[scalar @segs]}}\s*\Q$segs[-1]\E\s*$/ } 0 .. $#lines;
        die { status => 422, error => "parent group '$parent' not found in Targets" } unless defined $start;
        $insert_at = scalar @lines;
        for my $i ($start + 1 .. $#lines) {
            if ($lines[$i] =~ /^\s*(\++)\s*\S/ && length($1) <= scalar @segs) { $insert_at = $i; last }
        }
    }
    my $esc = sub { my $v = shift // ''; $v =~ s/[\r\n]//g; $v };
    my @block = ('', ('+' x $depth) . " $key",
        'menu = '  . $esc->($b->{menu}  || $key),
        'title = ' . $esc->($b->{title} || $b->{menu} || $key),
        "host = $host");
    push @block, 'probe = '  . $esc->($b->{probe})  if $b->{probe} && $b->{probe} =~ /^[A-Za-z0-9_]+$/;
    push @block, 'alerts = ' . join(',', grep { /^[A-Za-z0-9_-]+$/ } @{ $b->{alerts} || [] }) if @{ $b->{alerts} || [] };
    splice @lines, $insert_at, 0, @block;
    my $text = join("\n", @lines) . "\n";

    my $chk = _check_candidate('Targets', $text);
    return (422, { ok => \0, check => $chk, error => 'config check failed - target not added' }) unless _passed($chk);
    _spew("$file.bak", $s);
    _spew($file, $text, 0644);
    my $rl = _hup();
    return (200, { ok => \1, check => $chk, reload => $rl, path => '/' . join('/', @segs, $key) });
}

# Removing is destructive, so it demands the password *again* in the request
# body and verifies it against the htpasswd file - a cached session is not enough.
my $HTPASSWD = "$CONFIG_DIR/modern-auth/htpasswd";

sub _verify_password {
    my $pass = shift // '';
    my $user = $ENV{REMOTE_USER} // '';
    if (!-s $HTPASSWD) {
        # login disabled (WEBUI_AUTH=off): nothing to verify against
        return 1;
    }
    die { status => 401, error => 'not signed in' } unless length $user;
    die { status => 403, error => 'password confirmation required' } unless length $pass;
    my (undef, $rc) = _capture(10, '/usr/bin/htpasswd', '-vb', $HTPASSWD, $user, $pass);
    die { status => 403, error => 'password does not match' } unless $rc == 0;
    return 1;
}

sub target_remove {
    my $b = shift || {};
    _verify_password($b->{password});
    my $path = $b->{path} // '';
    $path =~ s{^/+}{}; $path =~ s{/+$}{};
    my @segs = split m{/}, $path;
    die { status => 422, error => 'path is required' } unless @segs;
    for (@segs) { die { status => 422, error => "bad path segment '$_'" } if /[^A-Za-z0-9_-]/ }

    my $file = "$CONFIG_DIR/Targets";
    my $s = _slurp($file) // die { status => 500, error => 'Targets file missing' };
    my @lines = split /\n/, $s;

    # walk the section headers to locate the exact node (depth + name chain)
    my @stack;                      # names by depth
    my ($start, $end);
    for my $i (0 .. $#lines) {
        next unless $lines[$i] =~ /^\s*(\++)\s*([A-Za-z0-9_-]+)\s*$/;
        my ($depth, $name) = (length $1, $2);
        if (defined $start && !defined $end && $depth <= scalar @segs) { $end = $i; last }
        $#stack = $depth - 2 if $depth - 1 <= $#stack;   # drop deeper levels
        $stack[$depth - 1] = $name;
        if (!defined $start && $depth == @segs && join('/', @stack[0 .. $depth - 1]) eq join('/', @segs)) { $start = $i }
    }
    die { status => 404, error => "target '/$path' not found in Targets" } unless defined $start;
    $end //= scalar @lines;
    # keep a leading blank line tidy
    my $from = $start; $from-- while $from > 0 && $lines[$from - 1] =~ /^\s*$/ && $from > $start - 1;
    my @removed = @lines[$start .. $end - 1];
    splice @lines, $from, $end - $from;
    my $text = join("\n", @lines) . "\n";
    my $children = scalar grep { /^\s*\++\s*\S/ } @removed[1 .. $#removed];

    my $chk = _check_candidate('Targets', $text);
    return (422, { ok => \0, check => $chk, error => 'config check failed - target not removed' }) unless _passed($chk);
    _spew("$file.bak", $s);
    _spew($file, $text, 0644);
    my $rl = _hup();

    my @deleted;
    if ($b->{deleteData}) {
        my $datadir = _datadir();
        my $base = "$datadir/$path";
        for my $f (glob("$base.rrd"), glob("$base.adr"), glob("$base~*.rrd")) { push @deleted, $f if -f $f && unlink $f }
        if (-d $base) {                          # a group: remove its subtree of rrd files
            require File::Find;
            File::Find::find({ no_chdir => 1, wanted => sub { push @deleted, $_ if -f $_ && /\.(rrd|adr)$/ && unlink $_ } }, $base);
            system('rmdir', '-p', $base) if -d $base;   # best effort, ignores non-empty
        }
    }
    return (200, { ok => \1, check => $chk, reload => $rl, path => "/$path", removedLines => scalar @removed,
                   removedChildren => $children, deletedFiles => \@deleted });
}

sub _datadir {
    my $s = _slurp("$CONFIG_DIR/pathnames") // '';
    my ($d) = $s =~ /^\s*datadir\s*=\s*(\S+)/m;
    return $d || '/data';
}

# ---------------------------------------------------------------------------
# acks (server-side silence)
# ---------------------------------------------------------------------------

sub acks_get {
    my $d = eval { $JSON->decode(_slurp($ACKS_FILE) // '{}') } || {};
    my $now = time;
    my $changed = 0;
    for my $k (keys %$d) {
        if ($d->{$k}{until} && $d->{$k}{until} < $now) { delete $d->{$k}; $changed = 1 }
    }
    _spew($ACKS_FILE, $JSON->canonical->encode($d), 0644) if $changed;
    return { acks => $d, now => $now };
}

sub acks_set {
    my $b = shift || {};
    my $key = $b->{key} // '';
    die { status => 422, error => 'key is required (path::alert or path)' } unless length $key;
    my $hours = $b->{hours};
    my $until = (defined $hours && $hours > 0) ? time + int($hours * 3600) : 0;
    my $d = acks_get()->{acks};
    $d->{$key} = { until => $until, note => substr(($b->{note} // ''), 0, 200), by => ($ENV{REMOTE_USER} // 'anon'), at => time };
    _spew($ACKS_FILE, $JSON->canonical->encode($d), 0644);
    return { ok => \1, acks => $d };
}

sub acks_delete {
    my $b = shift || {};
    my $key = $b->{key} // '';
    my $d = acks_get()->{acks};
    delete $d->{$key};
    _spew($ACKS_FILE, $JSON->canonical->encode($d), 0644);
    return { ok => \1, acks => $d };
}

# ---------------------------------------------------------------------------
# tests + reload
# ---------------------------------------------------------------------------

# Send a test message.
#   to:    address, comma-separated list, or "recipients" = the saved alert list
#   smtp:  optional - the E-mail form's *unsaved* values; when present the test
#          goes through a temporary msmtp config so you can test before saving
sub test_mail {
    my $b = shift || {};
    my $cur = _read_ssmtp();
    my @to;
    if (($b->{to} // '') eq 'recipients') {
        @to = @{ _read_alert_header()->{emails} };
        die { status => 422, error => 'no e-mail recipients are configured yet' } unless @to;
    } else {
        @to = grep { length } map { s/\s//gr } split /[,;\n]/, ($b->{to} // '');
    }
    die { status => 422, error => 'recipient address required' } unless @to;
    for (@to) { die { status => 422, error => "invalid address '$_'" } unless /^[^\s@]+@[^\s@]+$/ }

    my ($conf, $from, $engine, $tmpdir) = ($MSMTP_CONF, $cur->{root} || 'smokeping@localhost', 'msmtp', undef);
    if (ref $b->{smtp} eq 'HASH') {
        my $s = $b->{smtp};
        my $method = $s->{authMethod} // 'password';
        my $host = ($s->{host} // '') =~ s/\s//gr;
        $host ||= $method eq 'oauth-google' ? 'smtp.gmail.com' : $method eq 'oauth-microsoft' ? 'smtp.office365.com' : '';
        die { status => 422, error => 'mail server host is required' } unless length $host;
        die { status => 422, error => 'save the OAuth2 credentials first, then test' }
            if $method =~ /^oauth/ && !-s $OAUTH_CFG;
        $from = $s->{from} || $from;
        my $pass = length($s->{authPass} // '') ? $s->{authPass} : $cur->{_pass};
        $tmpdir = File::Temp::tempdir('spm-mailtest-XXXXXX', TMPDIR => 1, CLEANUP => 1);
        $conf = "$tmpdir/msmtp.conf";
        _write_msmtp_to($conf, { host => $host, port => int($s->{port} || 587), starttls => $s->{starttls} ? 1 : 0,
                                 tls => $s->{tls} ? 1 : 0, user => ($s->{authUser} // '') =~ s/\s//gr, pass => $pass,
                                 from => $from, method => $method });
        $engine = 'msmtp (unsaved form values)';
    } elsif (!-s $MSMTP_CONF) {
        $conf = undef; $engine = 'ssmtp';                 # legacy install, nothing saved through the UI yet
    }
    die { status => 422, error => 'from must be an e-mail address' } unless $from =~ /^[^\s@]+@[^\s@]+$/;

    my $host = (POSIX::uname())[1];
    my $when = scalar localtime;
    my $msg = join "\r\n",
        "To: " . join(', ', @to), "From: $from",
        "Subject: [SmokeAlert] TEST hostdown was raised on Demo.Target",
        "Content-Type: text/plain; charset=utf-8", "",
        "This is a TEST from modern-smokeping on $host - no target is actually down.",
        "A real alert mail from SmokePing looks like this:", "",
        "Alert \"hostdown\" was raised for Demo.Target",
        "Pattern: >90%,>90%,>90%,>90%,>90%,>90%",
        "Data (old -> now): loss: 0%, 0%, 100%, 100%, 100%, 100%, 100%, 100%",
        "                   rtt: 15ms, 15ms, U, U, U, U, U, U",
        "Comment: Host unreachable - >90% packet loss for ~1 minute", "",
        "Sent $when", "";

    my @cmd = defined $conf ? ('/usr/bin/msmtp', '-C', $conf, '-t') : ($SSMTP_BIN, '-t');
    my ($out, $rc) = _capture_in(60, $msg, @cmd);
    return { ok => ($rc == 0 ? \1 : \0), rc => $rc, engine => $engine, to => \@to, from => $from,
             output => ($out =~ s/\s+$//r) || ($rc == 0 ? 'accepted by the mail server' : "exit code $rc") };
}

# run a command feeding $stdin; returns (output, exit code)
sub _capture_in {
    my ($timeout, $stdin, @cmd) = @_;
    my ($in, $out) = (Symbol::gensym(), Symbol::gensym());
    my $pid = eval { IPC::Open3::open3($in, $out, undef, @cmd) };
    return ("cannot run $cmd[0]: $@", 127) unless $pid;
    print $in $stdin;
    close $in;
    my $buf = '';
    eval { local $SIG{ALRM} = sub { die "timeout\n" }; alarm $timeout; local $/; $buf = <$out> // ''; alarm 0; };
    if ($@) { kill 'KILL', $pid; $buf .= "\n(timed out after ${timeout}s)"; }
    waitpid $pid, 0;
    return ($buf, $? >> 8);
}

sub test_notify {
    my $b = shift || {};
    die { status => 500, error => 'notifier missing' } unless -x $NOTIFY_BIN;
    local $ENV{SPM_TEST} = 1;
    local $ENV{SPM_ONLY} = $b->{channel} // '';
    my ($out, $rc) = _capture(60, $NOTIFY_BIN, 'test', 'Test.Target', 'loss: 0%, 100%', 'rtt: 15ms, U', '127.0.0.1', 1);
    return { ok => ($rc == 0 ? \1 : \0), rc => $rc, output => ($out =~ s/\s+$//r) };
}

sub reload {
    my $chk = _check_config();
    return { ok => \0, check => $chk, error => 'config check failed - not reloading' } unless _passed($chk);
    return { ok => \1, check => $chk, reload => _hup() };
}

sub _hup {
    my ($pids) = _capture(10, 'sh', '-c', "pgrep -o -f 'sbin/smokeping --config' 2>/dev/null || ps -o pid,args | awk '/sbin\\/smokeping --config/ && !/awk/ {print \$1; exit}'");
    my ($pid) = ($pids // '') =~ /(\d+)/;
    return { ok => \0, note => 'smokeping master process not found' } unless $pid;
    my $n = kill 'HUP', $pid;
    return { ok => ($n ? \1 : \0), pid => $pid + 0, note => ($n ? 'HUP sent - SmokePing reloads its config' : "kill failed: $!") };
}

# run a command with a timeout; optional stdin; returns (output, exit code)
sub _capture {
    my ($timeout, @cmd) = @_;
    my $stdin = (@cmd > 2 && $cmd[0] eq $SSMTP_BIN) ? pop @cmd : undef;
    my ($in, $out) = (Symbol::gensym(), Symbol::gensym());
    my $pid = eval { IPC::Open3::open3($in, $out, undef, @cmd) };
    return ("cannot run $cmd[0]: $@", 127) unless $pid;
    if (defined $stdin) { print $in $stdin }
    close $in;
    my $buf = '';
    eval {
        local $SIG{ALRM} = sub { die "timeout\n" };
        alarm $timeout;
        local $/;
        $buf = <$out> // '';
        alarm 0;
    };
    if ($@) { kill 'KILL', $pid; $buf .= "\n(timed out after ${timeout}s)"; }
    waitpid $pid, 0;
    my $rc = $? >> 8;
    return ($buf, $rc);
}

1;
