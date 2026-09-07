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
my $NOTIFY_BIN = '/app/smokeping-modern/bin/notify';
my $SSMTP_CONF = "$CONFIG_DIR/ssmtp.conf";
my $NOTIFY_CFG = "$CONFIG_DIR/modern-notify.json";
my $ACKS_FILE  = "$CONFIG_DIR/modern-acks.json";

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
        return target_add($body)                    if $sub eq 'add' && $method eq 'POST';
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

sub _read_ssmtp {
    my %c;
    my $s = _slurp($SSMTP_CONF) // '';
    for my $line (split /\n/, $s) {
        next if $line =~ /^\s*#/ || $line !~ /=/;
        my ($k, $v) = split /=/, $line, 2;
        $k =~ s/^\s+|\s+$//g; $v =~ s/^\s+|\s+$//g;
        $c{$k} = $v;
    }
    my ($host, $port) = ($c{mailhub} // '') =~ /^([^:]*)(?::(\d+))?$/;
    return {
        host      => $host // '',
        port      => ($port // 587) + 0,
        starttls  => (($c{UseSTARTTLS} // 'no') =~ /yes/i ? \1 : \0),
        tls       => (($c{UseTLS} // 'no') =~ /yes/i ? \1 : \0),
        authUser  => $c{AuthUser} // '',
        passSet   => (length($c{AuthPass} // '') ? \1 : \0),
        root      => $c{root} // '',
        hostname  => $c{hostname} // '',
        _pass     => $c{AuthPass} // '',
    };
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
    my $host = $b->{host} // '';
    $host =~ s/\s//g;
    die { status => 422, error => 'mail server host is required' } unless length $host;
    my $port = int($b->{port} || 587);
    my $pass = defined $b->{authPass} && length $b->{authPass} ? $b->{authPass} : $cur->{_pass};
    my $from = $b->{from} || $cur->{root} || 'smokeping@localhost';
    die { status => 422, error => 'from must be an e-mail address' } unless $from =~ /^[^\s@]+@[^\s@]+$/;
    my @emails = grep { length } map { s/\s//gr } @{ $b->{to} || [] };
    for (@emails) { die { status => 422, error => "invalid recipient '$_'" } unless /^[^\s@]+@[^\s@]+$/ }

    my $conf = join "\n",
        "# managed by modern-smokeping - edit via the Settings page",
        "root=$from",
        "mailhub=$host:$port",
        "AuthUser=" . ($b->{authUser} // ''),
        "AuthPass=$pass",
        "UseSTARTTLS=" . ($b->{starttls} ? 'yes' : 'no'),
        "UseTLS=" . ($b->{tls} ? 'yes' : 'no'),
        "FromLineOverride=YES",
        "hostname=" . ($b->{hostname} || (POSIX::uname())[1]),
        "";
    _spew($SSMTP_CONF, $conf, 0640);
    _write_alert_header(\@emails, $from, $b->{webhooks} ? 1 : 0);

    my $chk = _check_config();
    my $rl = _passed($chk) ? _hup() : { ok => \0, note => 'not reloaded - config check failed' };
    return { ok => \1, check => $chk, reload => $rl, settings => settings_get() };
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

sub test_mail {
    my $b = shift || {};
    my $to = $b->{to} // '';
    $to =~ s/\s//g;
    die { status => 422, error => 'recipient address required' } unless $to =~ /^[^\s@]+@[^\s@]+$/;
    my $from = _read_ssmtp()->{root} || 'smokeping@localhost';
    my $host = (POSIX::uname())[1];
    my $msg = join "\r\n",
        "To: $to", "From: $from", "Subject: [SmokePing] test message",
        "Content-Type: text/plain; charset=utf-8", "",
        "This is a test message from modern-smokeping on $host.",
        "If you can read this, SMTP is configured correctly.",
        "", "Sent " . scalar(localtime), "";
    my ($out, $rc) = _capture(45, $SSMTP_BIN, '-t', $msg);
    return { ok => ($rc == 0 ? \1 : \0), rc => $rc, output => ($out =~ s/\s+$//r) || ($rc == 0 ? 'sent' : '') };
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
