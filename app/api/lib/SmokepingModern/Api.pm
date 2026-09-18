package SmokepingModern::Api;

# JSON backend for the SmokePing Modern UI.
#
# It deliberately reuses SmokePing's own machinery instead of re-implementing it:
#   * Smokeping::Info    - config parsing + numeric stats out of the rrd files
#   * Smokeping::init_alerts - compiles every "*** Alerts ***" entry into a coderef
#                          (and loads any Smokeping::matchers::* classes)
#   * RRDs               - time series straight from the .rrd files
#
# Endpoints (dispatched from smokeping-api.cgi on PATH_INFO):
#   GET /api/health          - liveness + config sanity
#   GET /api/tree            - full target hierarchy
#   GET /api/summary         - status counts + worst offenders
#   GET /api/node?path=&range=  - stats + smoke time series for one target
#   GET /api/alerts          - current alert state (live evaluation) + log history

use strict;
use warnings;

use lib '/usr/share/smokeping';

use JSON::PP ();
use RRDs;
use Smokeping::Info;
use Smokeping;
use SmokepingModern::Events ();

# stamped from the git tag at image build time (see Dockerfile); "dev" when run from a checkout
our $VERSION = '__APP_VERSION__';
$VERSION = 'dev' if $VERSION =~ /^__/;

my $CONF     = $ENV{SMOKEPING_CONF} || '/etc/smokeping/config';
my $LOGFILE  = $ENV{SMOKEPING_LOG}  || '';
my $LEGACY   = $ENV{SMOKEPING_CGI_URL} || '/smokeping/smokeping.cgi';

# range key => seconds. mirrors the "+ detail" section of the sample Presentation.
my %RANGE_SEC = (
    '3h'   => 3 * 3600,
    '30h'  => 30 * 3600,
    '10d'  => 10 * 86400,
    '360d' => 360 * 86400,
);

my $JSON = JSON::PP->new->utf8->canonical(0)->allow_blessed(1)->convert_blessed(1);

# ---------------------------------------------------------------------------
# HTTP entry point
# ---------------------------------------------------------------------------

sub run {
    my $path = $ENV{PATH_INFO} || '';
    $path =~ s{^/+}{};
    my ($route, @rest) = split m{/}, $path;
    $route ||= 'health';
    my $q = _query();
    my $method = uc($ENV{REQUEST_METHOD} || 'GET');

    # everything that writes (settings, config files, acks, tests, reload)
    # lives in SmokepingModern::Admin
    my %admin = map { $_ => 1 } qw(settings config targets acks test reload me oauth alertdefs);
    if ($admin{$route}) {
        my ($status, $body) = eval {
            require SmokepingModern::Admin;
            SmokepingModern::Admin::handle($method, $route, \@rest, $q, _read_body(), $JSON);
        };
        if ($@) {
            my $e = $@;
            ($status, $body) = ref $e eq 'HASH' ? ($e->{status} || 500, { error => $e->{error} || 'error' })
                                                : (500, { error => "$e" });
        }
        _invalidate_cache() if $status == 200 && $method ne 'GET';
        if (ref $body eq 'HASH' && defined $body->{html}) {      # e.g. the OAuth callback landing page
            print "Status: $status OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n\r\n", $body->{html};
            return;
        }
        _emit($status, $body);
        return;
    }

    my %ttl = (tree => 20, summary => 25, alerts => 25);
    my $data = eval {
        return health()                       if $route eq 'health';
        return _cached('tree', $ttl{tree}, \&tree)          if $route eq 'tree';
        return _cached('summary', $ttl{summary}, sub { summary($q) }) if $route eq 'summary';
        if ($route eq 'node') {
            my $safe = join '|', map { $q->{$_} // '' } qw(path range start end);
            $safe =~ s/[^A-Za-z0-9._|-]+/_/g;
            $safe =~ s/\|/./g;
            return _cached("node-$safe", 8, sub { node($q) });
        }
        return _cached('alerts', $ttl{alerts}, \&alerts)    if $route eq 'alerts';
        return _cached('events-' . _safe_key($q->{target}, $q->{since}, $q->{limit}), 20, sub { events($q) }) if $route eq 'events';
        return _cached('report-' . _safe_key($q->{range}), 60, sub { report($q) })  if $route eq 'report';
        return alertpreview($q)                                                    if $route eq 'alertpreview';
        return { __text => _cached_text('metrics', 10, \&metrics_text) }           if $route eq 'metrics';
        die { status => 404, error => "unknown route '$route'" };
    };
    if ($@) {
        my $err = $@;
        my ($status, $msg) = ref $err eq 'HASH'
            ? ($err->{status} || 500, $err->{error} || 'error')
            : (500, "$err");
        _emit($status, { error => $msg });
        return;
    }
    if (ref $data eq 'HASH' && exists $data->{__text}) {          # Prometheus exposition format
        print "Status: 200 OK\r\nContent-Type: text/plain; version=0.0.4; charset=utf-8\r\nCache-Control: no-store\r\n\r\n";
        print $data->{__text};
        return;
    }
    _emit(200, $data);
}

sub _safe_key { my $k = join '.', map { $_ // '' } @_; $k =~ s/[^A-Za-z0-9._-]+/_/g; return $k }

# same idea as _cached but for plain text (no JSON round trip)
sub _cached_text {
    my ($key, $ttl, $build) = @_;
    my $file = "/tmp/spm-cache-$key.txt";
    if (-f $file && (time - (stat $file)[9]) < $ttl && open my $fh, '<', $file) {
        local $/; my $t = <$fh>; close $fh; return $t if defined $t && length $t;
    }
    my $t = $build->();
    if (open my $fh, '>', "$file.$$") { print $fh $t; close $fh; rename "$file.$$", $file }
    return $t;
}

sub _emit {
    my ($status, $body) = @_;
    my %text = (200 => 'OK', 400 => 'Bad Request', 403 => 'Forbidden', 404 => 'Not Found',
                405 => 'Method Not Allowed', 422 => 'Unprocessable Entity', 500 => 'Internal Server Error');
    print "Status: $status " . ($text{$status} || 'OK') . "\r\n";
    print "Content-Type: application/json; charset=utf-8\r\n";
    print "Cache-Control: no-store\r\n";
    print "\r\n";
    print $JSON->encode($body);
}

# JSON request body (POST/PUT/DELETE). Under FCGI, STDIN is bound per request.
sub _read_body {
    my $len = $ENV{CONTENT_LENGTH} || 0;
    return undef unless $len > 0;
    die { status => 400, error => 'body too large' } if $len > 1_000_000;
    my $raw = '';
    my $got = read(STDIN, $raw, $len);
    return undef unless defined $got && length $raw;
    my $d = eval { $JSON->decode($raw) };
    die { status => 400, error => 'invalid JSON body' } unless $d;
    return $d;
}

# after a config write the cached tree/summary/alerts are stale
sub _invalidate_cache { unlink glob('/tmp/spm-cache-*.json'); }

# tiny on-disk response cache so a room full of dashboards does not stampede
# the rrd files. keyed by route; node detail is never cached.
sub _cached {
    my ($key, $ttl, $build) = @_;
    my $file = "/tmp/spm-cache-$key.json";
    if ($ttl && -f $file && (time - (stat $file)[9]) < $ttl) {
        if (open my $fh, '<', $file) {
            local $/;
            my $raw = <$fh>;
            close $fh;
            my $d = eval { $JSON->decode($raw) };
            return $d if $d;
        }
    }
    my $data = $build->();
    if ($ttl) {
        if (open my $fh, '>', "$file.$$") {
            print $fh $JSON->encode($data);
            close $fh;
            rename "$file.$$", $file;
        }
    }
    return $data;
}

sub _query {
    my %q;
    for my $pair (split /[&;]/, ($ENV{QUERY_STRING} || '')) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k && length $k;
        $v = '' unless defined $v;
        $v =~ tr/+/ /;
        $v =~ s/%([0-9A-Fa-f]{2})/chr hex $1/ge;
        $k =~ s/%([0-9A-Fa-f]{2})/chr hex $1/ge;
        $q{$k} = $v;
    }
    return \%q;
}

# ---------------------------------------------------------------------------
# config / smokeping bootstrap
# Under mod_fcgid the worker is long-lived, so the parsed config is kept and
# only re-read when a config file's mtime changes.
# ---------------------------------------------------------------------------

my ($_si, $_cfg, $_sig);

sub _cfg_signature {
    my $s = '';
    for my $f ($CONF, glob('/config/*')) {
        my @st = stat $f or next;
        $s .= "$f:$st[9]:$st[7];";
    }
    return $s;
}

sub _boot {
    my $sig = _cfg_signature();
    return ($_si, $_cfg) if $_si && $sig eq $_sig;
    die { status => 500, error => "config not found: $CONF" } unless -r $CONF;
    $_si  = Smokeping::Info->new($CONF);
    $_cfg = $_si->{cfg_hash};
    eval { Smokeping::init_alerts($_cfg); 1 }
        or warn "smokeping-modern: init_alerts failed: $@";
    $_sig = $sig;
    return ($_si, $_cfg);
}

sub _datadir { my (undef, $cfg) = _boot(); return $cfg->{General}{datadir} || '/data'; }
sub _step    { my (undef, $cfg) = _boot(); return $cfg->{Database}{step}   || 300; }

sub _rrd_for { my $path = shift; return _datadir() . $path . '.rrd'; }

sub _pings_for {
    my ($node) = @_;
    my ($si, $cfg) = _boot();
    my $probe = $node->{probe} && $si->{probe_hash}{ $node->{probe} };
    my $p = eval { $probe->_pings($node) };
    return $p if $p;
    return $cfg->{Database}{pings} || 20;
}

sub _bool { $_[0] ? JSON::PP::true : JSON::PP::false }

sub _num {
    my $v = shift;
    return undef unless defined $v && $v =~ /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
    return $v + 0;
}

# ---------------------------------------------------------------------------
# tree
# ---------------------------------------------------------------------------

sub _is_leaf {
    my $node = shift;
    return (exists $node->{host} && defined $node->{host} && $node->{host} !~ m{/}) ? 1 : 0;
}

sub _child_keys {
    my $node = shift;
    return sort { ($node->{$a}{_order} // 0) <=> ($node->{$b}{_order} // 0) }
           grep { $_ !~ /^_/ && ref $node->{$_} eq 'HASH' }
           keys %$node;
}

sub _walk {
    my ($node, $path) = @_;
    my $name = length $path ? (split m{/}, $path)[-1] : 'Top';
    my $leaf = _is_leaf($node);
    my @children = map { _walk($node->{$_}, "$path/$_") } _child_keys($node);

    my @alerts = $node->{alerts}
        ? (ref $node->{alerts} eq 'ARRAY' ? @{ $node->{alerts} }
                                          : split /\s*,\s*/, $node->{alerts})
        : ();

    return {
        name     => $name,
        path     => (length $path ? $path : '/'),
        title    => $node->{title} // $name,
        menu     => $node->{menu}  // $name,
        host     => $node->{host},
        probe    => $node->{probe},
        alerts   => \@alerts,
        isLeaf   => _bool($leaf),
        hasData  => _bool($leaf && -f _rrd_for($path)),
        children => \@children,
    };
}

sub tree {
    my ($si, $cfg) = _boot();
    my $root = _walk($cfg->{Targets}, '');
    return {
        generated => time,
        legacyUrl => $LEGACY,
        owner     => $cfg->{General}{owner},
        title     => $cfg->{Targets}{title} // 'SmokePing',
        ranges    => [ sort { $RANGE_SEC{$a} <=> $RANGE_SEC{$b} } keys %RANGE_SEC ],
        alertsDefined => [ sort grep { ref $cfg->{Alerts}{$_} eq 'HASH' } keys %{ $cfg->{Alerts} || {} } ],
        probesDefined => [ sort grep { ref $cfg->{Probes}{$_} eq 'HASH' } keys %{ $cfg->{Probes} || {} } ],
        root      => $root,
    };
}

# ---------------------------------------------------------------------------
# per-leaf iteration helper
# ---------------------------------------------------------------------------

sub _each_leaf {
    my ($node, $path, $cb) = @_;
    $cb->($node, $path) if _is_leaf($node) && length $path;
    _each_leaf($node->{$_}, "$path/$_", $cb) for _child_keys($node);
}

# ---------------------------------------------------------------------------
# node detail: stats + smoke series
# ---------------------------------------------------------------------------

sub node {
    my $q = shift;
    my ($si, $cfg) = _boot();
    my $path = $q->{path} || die { status => 404, error => 'missing ?path=' };
    $path = '/' . $path unless $path =~ m{^/};
    $path =~ s{\.\.}{}g;
    my $range = $RANGE_SEC{ $q->{range} || '3h' } ? ($q->{range} || '3h') : '3h';
    my $secs  = $RANGE_SEC{$range};

    # explicit window (zoom): ?start=<epoch>&end=<epoch>
    my ($start_arg, $end_arg) = ("-${secs}s", 'now');
    my ($zs, $ze) = (_num($q->{start}), _num($q->{end}));
    if (defined $zs && defined $ze && $ze > $zs && ($ze - $zs) >= 60) {
        ($start_arg, $end_arg) = (int $zs, int $ze);
        $secs = int($ze - $zs);
        $range = 'custom';
    }

    my $rrd = _rrd_for($path);
    die { status => 404, error => "no rrd for $path" } unless -f $rrd;

    # locate the node hash so we know pings + alerts + title
    my $found;
    _each_leaf($cfg->{Targets}, '', sub {
        my ($n, $p) = @_;
        $found = $n if $p eq $path;
    });
    my $pings = $found ? _pings_for($found) : ($cfg->{Database}{pings} || 20);

    my $stats = $si->stat_node({ path => $path, pings => $pings }, $start_arg, $end_arg);
    my $series = _smoke_series($rrd, $pings, $start_arg, $end_arg);

    my @alerts = $found && $found->{alerts}
        ? (ref $found->{alerts} eq 'ARRAY' ? @{ $found->{alerts} }
                                           : split /\s*,\s*/, $found->{alerts})
        : ();

    return {
        generated => time,
        path      => $path,
        title     => ($found && $found->{title}) || (split m{/}, $path)[-1],
        host      => $found && $found->{host},
        probe     => $found && $found->{probe},
        range     => $range,
        window    => { start => ($series->{t}[0] // undef), end => ($series->{t}[-1] // undef) },
        pings     => $pings + 0,
        legacyUrl => "$LEGACY?target=" . _legacy_target($path),
        alerts    => \@alerts,
        stats     => {
            medianAvgMs => _ms($stats->{med_avg}),
            medianMinMs => _ms($stats->{med_min}),
            medianMaxMs => _ms($stats->{med_max}),
            medianNowMs => _ms($stats->{med_now}),
            lossAvgPct  => _pct($stats->{loss_avg}),
            lossMaxPct  => _pct($stats->{loss_max}),
            lossNowPct  => _pct($stats->{loss_now}),
        },
        series => $series,
    };
}

sub _ms  { my $v = _num($_[0]); defined $v ? $v * 1000 : undef }
sub _pct { my $v = _num($_[0]); defined $v ? $v * 100  : undef }

# pull median / loss / pingN straight from the rrd and derive percentile bands
sub _smoke_series {
    my ($rrd, $pings, $start_arg, $end_arg) = @_;
    my ($start, $step, $names, $data) =
        RRDs::fetch($rrd, 'AVERAGE', '--start', $start_arg, '--end', $end_arg);
    if (my $e = RRDs::error()) { die { status => 500, error => "rrd fetch: $e" } }

    my %col;
    $col{ $names->[$_] } = $_ for 0 .. $#$names;
    my @ping_cols = map { $col{"ping$_"} } grep { defined $col{"ping$_"} } 1 .. $pings;

    my (@t, @median, @loss, @pmin, @p10, @p20, @p50, @p80, @p90, @pmax);
    my $ts = $start;
    for my $row (@$data) {
        push @t, $ts * 1;
        $ts += $step;

        my $med = $row->[ $col{median} ];
        push @median, defined $med ? $med * 1000 : undef;

        my $l = $row->[ $col{loss} ];
        push @loss, defined $l ? ($l * 100 / $pings) : undef;

        my @vals = sort { $a <=> $b }
                   grep { defined $_ }
                   map  { $row->[$_] } @ping_cols;
        if (@vals) {
            my $q = sub { $vals[ int($_[0] * $#vals + 0.5) ] * 1000 };
            push @pmin, $vals[0] * 1000;
            push @p10,  $q->(0.1);
            push @p20,  $q->(0.2);
            push @p50,  $q->(0.5);
            push @p80,  $q->(0.8);
            push @p90,  $q->(0.9);
            push @pmax, $vals[-1] * 1000;
        } else {
            push @$_, undef for \@pmin, \@p10, \@p20, \@p50, \@p80, \@p90, \@pmax;
        }
    }

    return {
        step   => $step * 1,
        t      => \@t,
        median => \@median,
        loss   => \@loss,
        pmin   => \@pmin,
        p10    => \@p10,
        p20    => \@p20,
        p50    => \@p50,
        p80    => \@p80,
        p90    => \@p90,
        pmax   => \@pmax,
    };
}

sub _legacy_target {
    my $p = shift;
    $p =~ s{^/}{};
    $p =~ s{/}{.}g;
    return $p;
}

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

sub summary {
    my $q = shift;
    my ($si, $cfg) = _boot();
    my $secs = $RANGE_SEC{ $q->{range} || '3h' } || $RANGE_SEC{'3h'};

    my $alert_state = _alert_index();  # path => worst severity from live eval

    my (@nodes, %counts);
    $counts{$_} = 0 for qw(ok warning critical down unknown);

    _each_leaf($cfg->{Targets}, '', sub {
        my ($n, $p) = @_;
        my $rrd = _rrd_for($p);
        my ($lossNow, $medNow, $medAvg, $stddev, $spark);
        if (-f $rrd) {
            my $pings = _pings_for($n);
            my $s = $si->stat_node({ path => $p, pings => $pings }, "-${secs}s", 'now');
            $lossNow = _num($s->{loss_now});
            $medNow  = _num($s->{med_now});
            $medAvg  = _num($s->{med_avg});
            ($stddev, $spark) = _rrd_stddev_spark($rrd, $secs, $pings);
        }

        # loss is a fraction 0..1. a single dropped ping (~1/20) is noise;
        # escalate only at sustained loss, and call it down at ~total loss.
        my $sev = 'unknown';
        if (defined $lossNow || defined $medNow) {
            $sev = 'ok';
            if (defined $lossNow) {
                $sev = 'warning' if $lossNow >= 0.10;
                $sev = 'down'    if $lossNow >= 0.90;
            }
        }
        if (my $as = $alert_state->{$p}) {
            $sev = 'warning'  if $sev eq 'ok' || $sev eq 'unknown';
            $sev = 'critical' if $as eq 'critical' && $sev ne 'down';
        }
        $counts{$sev}++;

        push @nodes, {
            path        => $p,
            title       => $n->{title} // (split m{/}, $p)[-1],
            host        => $n->{host},
            severity    => $sev,
            lossNowPct  => defined $lossNow ? $lossNow * 100 : undef,
            medianNowMs => defined $medNow  ? $medNow * 1000 : undef,
            medianAvgMs => defined $medAvg  ? $medAvg * 1000 : undef,
            stddevMs    => $stddev,
            spark       => $spark,
            hasData     => _bool(-f $rrd),
        };
    });

    my @by_loss    = sort { ($b->{lossNowPct}  // -1) <=> ($a->{lossNowPct}  // -1) } @nodes;
    my @by_latency = sort { ($b->{medianNowMs} // -1) <=> ($a->{medianNowMs} // -1) } @nodes;
    my @by_stddev  = sort { ($b->{stddevMs}    // -1) <=> ($a->{stddevMs}    // -1) } @nodes;

    return {
        generated    => time,
        total        => scalar @nodes,
        counts       => \%counts,
        nodes        => \@nodes,
        worstLoss    => [ grep { ($_->{lossNowPct}  // 0) > 0 } @by_loss[0 .. 7] ],
        worstLatency => [ grep { defined $_->{medianNowMs} } @by_latency[0 .. 7] ],
        worstStddev  => [ grep { ($_->{stddevMs} // 0) > 0 } @by_stddev[0 .. 7] ],
    };
}

# one fetch -> stddev (over the window) + a ~60-point sparkline for the card
sub _rrd_stddev_spark {
    my ($rrd, $secs, $pings) = @_;
    $pings ||= 20;
    my ($start, $step, $names, $data) =
        RRDs::fetch($rrd, 'AVERAGE', '--start', "-${secs}s", '--end', 'now');
    return (undef, undef) if RRDs::error();
    my %col;
    $col{ $names->[$_] } = $_ for 0 .. $#$names;
    return (undef, undef) unless defined $col{median};

    my @medAll = map { $_->[ $col{median} ] } @$data;
    my @losAll = defined $col{loss} ? map { $_->[ $col{loss} ] } @$data : ();

    # stddev over the whole window
    my @v = grep { defined } @medAll;
    my $stddev;
    if (@v >= 3) {
        my $mean = 0; $mean += $_ for @v; $mean /= @v;
        my $var = 0; $var += ($_ - $mean) ** 2 for @v; $var /= @v;
        $stddev = sqrt($var) * 1000;
    }

    # sparkline: only the most recent slice, so it is legible from minute one
    my $tail = 240;                       # ~40 min at a 10 s step
    my $from = @medAll > $tail ? @medAll - $tail : 0;
    my @med = @medAll[ $from .. $#medAll ];
    my @los = @losAll ? @losAll[ $from .. $#losAll ] : ();

    my $want = 60;
    my $n = scalar @med;
    my $bucket = $n > $want ? int($n / $want) + 1 : 1;
    my (@sm, @sl);
    for (my $i = 0; $i < $n; $i += $bucket) {
        my $hi = $i + $bucket - 1; $hi = $n - 1 if $hi >= $n;
        my (@mm, @ll);
        for my $j ($i .. $hi) {
            push @mm, $med[$j] if defined $med[$j];
            push @ll, $los[$j] if @los && defined $los[$j];
        }
        push @sm, @mm ? (_avg(@mm) * 1000) : undef;
        push @sl, @ll ? (_avg(@ll) * 100 / $pings) : undef;   # loss in %
    }
    my $spark = { median => \@sm, loss => \@sl, step => $step * $bucket };
    return ($stddev, $spark);
}

sub _avg { my $s = 0; $s += $_ for @_; return @_ ? $s / @_ : undef }

# ---------------------------------------------------------------------------
# alerts - live evaluation of every target's assigned alert patterns
# ---------------------------------------------------------------------------

sub alerts {
    my ($si, $cfg) = _boot();
    my @active;
    eval { SmokepingModern::Events::ingest() };      # keep the persistent incident store current

    _each_leaf($cfg->{Targets}, '', sub {
        my ($n, $p) = @_;
        my $spec = $n->{alerts} or return;
        my @names = ref $spec eq 'ARRAY' ? @$spec : split /\s*,\s*/, $spec;
        return unless @names;
        my $rrd = _rrd_for($p);
        return unless -f $rrd;
        my $pings = _pings_for($n);

        for my $an (@names) {
            my $alert = $cfg->{Alerts}{$an} or next;
            next unless ref $alert->{sub} eq 'CODE';
            my $len = $alert->{maxlength} || 12;
            my ($loss, $rtt) = _alert_series($rrd, $pings, $len + 3);
            next unless @$loss;

            my $x = { loss => $loss, rtt => $rtt, prevmatch => 0 };
            my $match = eval { $alert->{sub}->($x) } || 0;
            next unless $match;

            push @active, {
                path           => $p,
                target         => $n->{title} // (split m{/}, $p)[-1],
                host           => $n->{host},
                alert          => $an,
                type           => $alert->{type} // 'matcher',
                pattern        => $alert->{pattern},
                comment        => $alert->{comment},
                priority       => defined $alert->{priority} ? $alert->{priority} + 0 : undef,
                edgetrigger    => _bool(($alert->{edgetrigger} // 'no') eq 'yes'),
                severity       => _severity($alert, $loss),
                currentLossPct => defined $loss->[-1] ? $loss->[-1] + 0 : undef,
                currentRttMs   => defined $rtt->[-1]  ? $rtt->[-1] * 1000 : undef,
                lossSamples    => [ map { defined $_ ? $_ + 0 : undef } @$loss ],
                rttSamples     => [ map { defined $_ ? $_ * 1000 : undef } @$rtt ],
            };
        }
    });

    @active = sort {
        _sev_rank($b->{severity}) <=> _sev_rank($a->{severity})
            or ($b->{currentLossPct} // 0) <=> ($a->{currentLossPct} // 0)
            or $a->{path} cmp $b->{path}
    } @active;

    my ($events, $logfile) = _parse_log();
    return {
        generated => time,
        active    => \@active,
        recent    => $events,
        logSource => $logfile,
    };
}

# path => 'critical'|'warning' for whatever alerts currently fire
sub _alert_index {
    my $a = eval { _cached('alerts', 25, \&alerts) } or return {};
    my %idx;
    for my $row (@{ $a->{active} || [] }) {
        my $cur = $idx{ $row->{path} } || '';
        $idx{ $row->{path} } = $row->{severity}
            if _sev_rank($row->{severity}) > _sev_rank($cur);
    }
    return \%idx;
}

sub _sev_rank {
    my $s = shift // '';
    return { ok => 0, unknown => 0, warning => 1, down => 2, critical => 3 }->{$s} // 0;
}

sub _severity {
    my ($alert, $loss) = @_;
    if (defined $alert->{priority}) {
        return $alert->{priority} <= 2 ? 'critical' : 'warning';
    }
    my $last = $loss->[-1];
    if (($alert->{type} // '') eq 'loss') {
        return 'critical' if defined $last && $last >= 99;
        return 'warning';
    }
    return 'warning';
}

# newest value last, matching Smokeping::check_alerts stack order
sub _alert_series {
    my ($rrd, $pings, $want) = @_;
    my $step = _step();
    my ($start, $rstep, $names, $data) =
        RRDs::fetch($rrd, 'AVERAGE', '--start', "-" . ($want * $step + $step) . "s", '--end', 'now');
    return ([], []) if RRDs::error();

    my %col;
    $col{ $names->[$_] } = $_ for 0 .. $#$names;
    return ([], []) unless defined $col{loss} && defined $col{median};

    my (@loss, @rtt);
    for my $row (@$data) {
        my $l = $row->[ $col{loss} ];
        my $m = $row->[ $col{median} ];
        push @loss, defined $l ? ($l * 100 / $pings) : undef;
        push @rtt,  defined $m ? $m : undef;
    }
    # drop trailing slots the poller has not filled yet
    while (@loss && !defined $loss[-1] && !defined $rtt[-1]) { pop @loss; pop @rtt; }
    return (\@loss, \@rtt);
}

# ---------------------------------------------------------------------------
# alert history from a log file (best effort - SmokePing has no alert db)
# ---------------------------------------------------------------------------

sub _parse_log {
    my @files = grep { $_ && -r $_ } ($LOGFILE, '/config/log/smokeping.log',
        '/config/log/smokeping/current', '/var/log/smokeping/current',
        '/var/log/smokeping.log', '/var/log/messages');
    # a touched-but-empty default log is not a real source
    my ($file) = grep { -s $_ } @files;
    $file ||= (grep { $_ } @files)[0];
    return ([], undef) unless $file && -s $file;

    open my $fh, '<', $file or return ([], undef);
    my @lines = <$fh>;
    close $fh;
    @lines = @lines[ -2000 .. -1 ] if @lines > 2000;

    my @events;
    for my $line (@lines) {
        next unless $line =~ /Alert\s+(\S+)\s+(was raised|was cleared|is active)\s+for\s+(\S+)/;
        my ($alert, $what, $target) = ($1, $2, $3);
        my $ts;
        if ($line =~ /^\@(\d{9,})/)                            { $ts = $1 }
        elsif ($line =~ /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)/) { $ts = _parse_ts($1) }
        elsif ($line =~ /^\w{3}\s+(\w{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})/) {
            # perl localtime() form:  "Sun Sep  7 22:40:01 2026 - ..."
            my %m = qw(Jan 0 Feb 1 Mar 2 Apr 3 May 4 Jun 5 Jul 6 Aug 7 Sep 8 Oct 9 Nov 10 Dec 11);
            require POSIX;
            $ts = eval { POSIX::mktime($5, $4, $3, $2, $m{$1}, $6 - 1900) };
        }
        elsif ($line =~ /^(\w{3}\s+\d+\s+\d\d:\d\d:\d\d)/)     { $ts = _parse_syslog_ts($1) }
        push @events, {
            time   => $ts,
            alert  => $alert,
            event  => ($what eq 'was cleared' ? 'cleared' : 'raised'),
            target => $target,
        };
    }
    # level-triggered alerts log "is active" every cycle; collapse runs of the
    # same (alert,target,event) into one entry that keeps the first time + a count
    my @collapsed;
    for my $e (@events) {
        my $last = $collapsed[-1];
        if ($last && $last->{alert} eq $e->{alert} && $last->{target} eq $e->{target} && $last->{event} eq $e->{event}) {
            $last->{count}++;
            $last->{last} = $e->{time} if defined $e->{time};
            next;
        }
        push @collapsed, { %$e, count => 1, last => $e->{time} };
    }
    @events = reverse @collapsed;
    @events = @events[ 0 .. 199 ] if @events > 200;
    return (\@events, $file);
}

sub _parse_ts {
    my $s = shift;
    my @p = $s =~ /(\d+)/g;
    require POSIX;
    return eval { POSIX::mktime($p[5], $p[4], $p[3], $p[2], $p[1] - 1, $p[0] - 1900) };
}

sub _parse_syslog_ts {
    my $s = shift;
    my %mon = qw(Jan 0 Feb 1 Mar 2 Apr 3 May 4 Jun 5 Jul 6 Aug 7 Sep 8 Oct 9 Nov 10 Dec 11);
    return undef unless $s =~ /(\w{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)/;
    require POSIX;
    my @now = localtime;
    return eval { POSIX::mktime($5, $4, $3, $2, $mon{$1}, $now[5]) };
}

# ---------------------------------------------------------------------------
# incident history (persistent, see SmokepingModern::Events)
# ---------------------------------------------------------------------------

# Incidents for targets that still exist. A target removed while an alert was
# raised never logs a "cleared" line and would otherwise stay "open" forever.
sub _live_incidents {
    my ($now, $titles) = @_;
    $titles ||= _title_map();
    my $inc = SmokepingModern::Events::incidents(SmokepingModern::Events::read_store(), $now);
    return [ grep { exists $titles->{ $_->{path} } } @$inc ];
}

# path => title for every leaf
sub _title_map {
    my ($si, $cfg) = _boot();
    my %t;
    _each_leaf($cfg->{Targets}, '', sub { my ($n, $p) = @_; $t{$p} = $n->{title} // (split m{/}, $p)[-1]; });
    return \%t;
}

my %HIST_SEC = ('24h' => 86400, '7d' => 7 * 86400, '30d' => 30 * 86400, '90d' => 90 * 86400, '365d' => 365 * 86400);

sub events {
    my $q = shift;
    eval { SmokepingModern::Events::ingest() };
    my $now   = time;
    my $range = $HIST_SEC{ $q->{range} || '' } ? $q->{range} : '30d';
    my $since = _num($q->{since});
    $since = $now - $HIST_SEC{$range} unless defined $since;
    my $limit = _num($q->{limit}) || 500;
    $limit = 2000 if $limit > 2000;

    my $titles = _title_map();
    my $inc  = _live_incidents($now, $titles);
    my $want = $q->{target} // '';

    my @rows = grep { ($_->{end} // $now) >= $since }                # overlaps the window
               grep { !length $want || $_->{path} eq $want } @$inc;
    @rows = reverse @rows;                                            # newest first
    my $total = scalar @rows;
    @rows = @rows[0 .. $limit - 1] if @rows > $limit;

    my ($sum, $closed, $open, $longest) = (0, 0, 0, 0);
    my %by;
    for my $r (@rows) {
        $r->{title} = $titles->{ $r->{path} } // (split m{/}, $r->{path})[-1];
        $r->{open}  = _bool($r->{open});
        $r->{level} = _bool($r->{level});
        if ($r->{durationSec} !~ /^-/) {
            $sum += $r->{durationSec}; $closed++;
            $longest = $r->{durationSec} if $r->{durationSec} > $longest;
        }
        $open++ if $r->{open};
        $by{ $r->{path} }++;
    }
    return {
        generated => $now,
        range     => $range,
        since     => $since + 0,
        total     => $total,
        open      => $open,
        avgSec    => $closed ? int($sum / $closed) : undef,
        longestSec => $longest,
        byTarget  => [ map { { path => $_, title => $titles->{$_} // $_, count => $by{$_} } }
                       sort { $by{$b} <=> $by{$a} || $a cmp $b } keys %by ],
        incidents => \@rows,
        store     => SmokepingModern::Events::store_file(),
    };
}

# ---------------------------------------------------------------------------
# availability / SLA report
# ---------------------------------------------------------------------------

my %REPORT_SEC = %HIST_SEC;
my $DOWN_LOSS  = 90;      # a slot with >= 90 % loss counts as "down"

sub _pctile {
    my ($sorted, $p) = @_;
    return undef unless @$sorted;
    return $sorted->[ int($p * $#$sorted + 0.5) ];
}

sub report {
    my $q = shift;
    my ($si, $cfg) = _boot();
    my $now   = time;
    my $range = $REPORT_SEC{ $q->{range} || '' } ? $q->{range} : '7d';
    my $secs  = $REPORT_SEC{$range};

    eval { SmokepingModern::Events::ingest() };
    my $inc = _live_incidents($now);
    my %inc_n; my %inc_longest;
    for my $i (@$inc) {
        next if ($i->{end} // $now) < $now - $secs;
        $inc_n{ $i->{path} }++;
        $inc_longest{ $i->{path} } = $i->{durationSec} if ($inc_longest{ $i->{path} } // 0) < $i->{durationSec};
    }

    my (@rows, %grp);
    _each_leaf($cfg->{Targets}, '', sub {
        my ($n, $p) = @_;
        my $rrd = _rrd_for($p);
        return unless -f $rrd;
        my $pings = _pings_for($n);
        my ($start, $step, $names, $data) =
            RRDs::fetch($rrd, 'AVERAGE', '--start', "-${secs}s", '--end', 'now');
        return if RRDs::error() || !$data || !@$data;
        my %col; $col{ $names->[$_] } = $_ for 0 .. $#$names;
        return unless defined $col{loss} && defined $col{median};

        my ($known, $downSlots, $lossSum, @med, %hour);
        my $ts = $start;
        for my $row (@$data) {
            my ($t, $l, $m) = ($ts, $row->[ $col{loss} ], $row->[ $col{median} ]);
            $ts += $step;
            next unless defined $l;
            my $lp = $l * 100 / $pings;
            $lp = 100 if $lp > 100;
            $known++;
            $lossSum += $lp;
            $downSlots++ if $lp >= $DOWN_LOSS;
            push @med, $m * 1000 if defined $m;
            my $h = $t - $t % 3600;
            $hour{$h}[0] += $lp; $hour{$h}[1]++;
        }
        return unless $known;
        my @sorted = sort { $a <=> $b } @med;
        my ($worst, $worstLoss) = (undef, -1);
        for my $h (keys %hour) {
            my $avg = $hour{$h}[0] / $hour{$h}[1];
            ($worst, $worstLoss) = ($h, $avg) if $avg > $worstLoss;
        }
        my $avgLoss = $lossSum / $known;
        my $covered = $known * $step;
        my $row = {
            path         => $p,
            title        => $n->{title} // (split m{/}, $p)[-1],
            host         => $n->{host},
            group        => (($p =~ m{^(.*)/[^/]+$}) ? $1 : ''),
            availability => 100 - $avgLoss,                        # packet based: 100 - mean loss
            downtimeSec  => int($downSlots * $step),               # time in >=90 % loss slots
            lossMinutes  => $lossSum / 100 * $step / 60,           # "equivalent full-outage minutes"
            avgLossPct   => $avgLoss,
            avgMs        => @med ? _avg(@med) : undef,
            p95Ms        => _pctile(\@sorted, 0.95),
            maxMs        => @sorted ? $sorted[-1] : undef,
            worstHour    => ($worstLoss > 0 ? { t => $worst + 0, lossPct => $worstLoss } : undef),
            incidents    => $inc_n{$p} || 0,
            longestSec   => $inc_longest{$p} || 0,
            coveragePct  => min_(100, 100 * $covered / $secs),
            stepSec      => $step + 0,
        };
        push @rows, $row;
    });

    # roll up per group (parent folder)
    for my $r (@rows) {
        my $g = $grp{ $r->{group} } ||= { path => $r->{group}, targets => 0, avSum => 0, downtimeSec => 0,
                                          lossMinutes => 0, incidents => 0, worst => undef };
        $g->{targets}++;
        $g->{avSum}       += $r->{availability};
        $g->{downtimeSec} += $r->{downtimeSec};
        $g->{lossMinutes} += $r->{lossMinutes};
        $g->{incidents}   += $r->{incidents};
        $g->{worst} = $r if !$g->{worst} || $r->{availability} < $g->{worst}{availability};
    }
    my @groups = map {
        my $g = $grp{$_};
        { path => $g->{path}, title => (length $g->{path} ? (split m{/}, $g->{path})[-1] : 'Top level'),
          targets => $g->{targets}, availability => $g->{avSum} / $g->{targets},
          downtimeSec => $g->{downtimeSec}, lossMinutes => $g->{lossMinutes}, incidents => $g->{incidents},
          worstTarget => $g->{worst}{title} }
    } sort keys %grp;

    @rows = sort { $a->{availability} <=> $b->{availability} || $a->{path} cmp $b->{path} } @rows;
    my $n = scalar @rows;
    return {
        generated => $now,
        range     => $range,
        rangeSec  => $secs,
        downLossPct => $DOWN_LOSS,
        summary   => {
            targets      => $n,
            availability => $n ? _avg(map { $_->{availability} } @rows) : undef,
            downtimeSec  => (eval { my $s = 0; $s += $_->{downtimeSec} for @rows; $s } || 0),
            incidents    => (eval { my $s = 0; $s += $_->{incidents} for @rows; $s } || 0),
            perfect      => scalar(grep { $_->{availability} >= 99.999 } @rows),
        },
        groups    => \@groups,
        targets   => \@rows,
    };
}

sub min_ { $_[0] < $_[1] ? $_[0] : $_[1] }

# ---------------------------------------------------------------------------
# Prometheus exposition
# ---------------------------------------------------------------------------

sub _lbl {
    my %l = @_;
    return '{' . join(',', map { my $v = $l{$_} // ''; $v =~ s/\\/\\\\/g; $v =~ s/"/\\"/g; $v =~ s/\n/\\n/g; qq($_="$v") } sort keys %l) . '}';
}

sub metrics_text {
    eval { SmokepingModern::Events::ingest() };
    my $out = '';
    my $emit = sub {
        my ($name, $type, $help, $rows) = @_;
        return unless @$rows;
        $out .= "# HELP $name $help\n# TYPE $name $type\n";
        $out .= "$name$_->[0] $_->[1]\n" for @$rows;
    };
    my $ok = eval { _boot(); 1 } ? 1 : 0;
    $emit->('smokeping_modern_up', 'gauge', 'API can read the SmokePing config (1) or not (0).', [ ['', $ok] ]);
    $emit->('smokeping_modern_info', 'gauge', 'Modern UI version.', [ [ _lbl(version => $VERSION), 1 ] ]);
    return $out unless $ok;

    my $s = eval { summary({}) } || { nodes => [], counts => {} };
    my (@loss, @med, @sd, @st, @dat);
    my %rank = (ok => 0, unknown => 0, warning => 1, critical => 2, down => 3);
    for my $n (@{ $s->{nodes} }) {
        my %l = (path => $n->{path}, title => $n->{title}, host => $n->{host});
        push @dat, [ _lbl(%l), $n->{hasData} ? 1 : 0 ];
        push @st,  [ _lbl(%l), $rank{ $n->{severity} } // 0 ];
        push @loss, [ _lbl(%l), $n->{lossNowPct} + 0 ]            if defined $n->{lossNowPct};
        push @med,  [ _lbl(%l), sprintf('%.6f', $n->{medianNowMs} / 1000) ] if defined $n->{medianNowMs};
        push @sd,   [ _lbl(%l), sprintf('%.6f', $n->{stddevMs} / 1000) ]    if defined $n->{stddevMs};
    }
    $emit->('smokeping_target_loss_percent', 'gauge', 'Current packet loss per target, percent.', \@loss);
    $emit->('smokeping_target_median_rtt_seconds', 'gauge', 'Current median round trip time per target.', \@med);
    $emit->('smokeping_target_rtt_stddev_seconds', 'gauge', 'RTT standard deviation over the last 3 h.', \@sd);
    $emit->('smokeping_target_status', 'gauge', 'Target status: 0 ok, 1 warning, 2 critical, 3 down.', \@st);
    $emit->('smokeping_target_has_data', 'gauge', 'Target has an RRD with data.', \@dat);
    $emit->('smokeping_targets', 'gauge', 'Targets by status.',
            [ map { [ _lbl(status => $_), $s->{counts}{$_} + 0 ] } sort keys %{ $s->{counts} } ]);

    my $a = eval { _cached('alerts', 25, \&alerts) } || { active => [] };
    $emit->('smokeping_alert_active', 'gauge', 'A configured alert currently matches (1).',
            [ map { [ _lbl(alert => $_->{alert}, path => $_->{path}, severity => $_->{severity}), 1 ] } @{ $a->{active} } ]);
    $emit->('smokeping_alerts_active', 'gauge', 'Number of alerts currently firing.', [ ['', scalar @{ $a->{active} }] ]);

    my $now = time;
    my $inc = _live_incidents($now);
    my $open = scalar grep { $_->{open} } @$inc;
    my $last24 = scalar grep { ($_->{end} // $now) >= $now - 86400 } @$inc;
    $emit->('smokeping_incidents_open', 'gauge', 'Incidents currently open.', [ ['', $open] ]);
    $emit->('smokeping_incidents_24h', 'gauge', 'Incidents that were open at any time in the last 24 hours.', [ ['', $last24] ]);
    return $out;
}

# ---------------------------------------------------------------------------
# alert rule preview: what would this rule do on today's data?
# ---------------------------------------------------------------------------

sub alertpreview {
    my $q = shift;
    require SmokepingModern::AlertRule;
    my ($si, $cfg) = _boot();
    my $step = _step();
    my $rule = SmokepingModern::AlertRule::build($q, $step);

    # compile just this one rule with SmokePing's own alert compiler
    my $fake = { Alerts => { preview => { type => $rule->{type}, pattern => $rule->{pattern} } } };
    eval { Smokeping::init_alerts($fake); 1 }
        or die { status => 422, error => "SmokePing rejects that rule: " . (split /\n/, "$@")[0] };
    my $alert = $fake->{Alerts}{preview};
    die { status => 422, error => 'rule did not compile' } unless ref $alert->{sub} eq 'CODE';
    my $len = $alert->{maxlength} || 12;

    my $replay_h = 20;                                   # hours replayed (fine-resolution RRA covers ~24 h)
    my $fetch_s  = $replay_h * 3600 + ($len + 3) * $step;
    my $stride   = $step < 60 ? int(60 / $step) : 1;     # evaluate about once a minute

    my (@now, @rep, $total_raises);
    my $count = 0;
    _each_leaf($cfg->{Targets}, '', sub {
        my ($n, $p) = @_;
        return if $count >= 150;
        my $rrd = _rrd_for($p);
        return unless -f $rrd;
        $count++;
        my $pings = _pings_for($n);
        my ($start, $rstep, $names, $data) =
            RRDs::fetch($rrd, 'AVERAGE', '--start', "-${fetch_s}s", '--end', 'now');
        return if RRDs::error() || !$data || !@$data;
        my %col; $col{ $names->[$_] } = $_ for 0 .. $#$names;
        return unless defined $col{loss} && defined $col{median};
        my (@loss, @rtt);
        for my $row (@$data) {
            my ($l, $m) = ($row->[ $col{loss} ], $row->[ $col{median} ]);
            push @loss, defined $l ? $l * 100 / $pings : undef;
            push @rtt,  $m;
        }
        while (@loss && !defined $loss[-1] && !defined $rtt[-1]) { pop @loss; pop @rtt }
        return unless @loss;
        my $title = $n->{title} // (split m{/}, $p)[-1];

        # firing right now (same evaluation as the live Alerts page)
        my $w = $len + 3;
        my $from = @loss > $w ? @loss - $w : 0;
        my $x = { loss => [ @loss[$from .. $#loss] ], rtt => [ @rtt[$from .. $#rtt] ], prevmatch => 0 };
        if (eval { $alert->{sub}->($x) }) {
            push @now, { path => $p, title => $title,
                         lossPct => defined $loss[-1] ? $loss[-1] + 0 : undef,
                         rttMs   => defined $rtt[-1] ? $rtt[-1] * 1000 : undef };
        }

        # replay: slide over the history, feeding prevmatch back in like the daemon does
        my ($prev, $raises, $firing, $first, $last) = (0, 0, 0, undef, undef);
        my $t0 = $start;
        for (my $i = $w; $i <= $#loss; $i += $stride) {
            my $y = { loss => [ @loss[$i - $w + 1 .. $i] ], rtt => [ @rtt[$i - $w + 1 .. $i] ], prevmatch => $prev };
            my $m = eval { $alert->{sub}->($y) } ? 1 : 0;
            if ($m && !$prev) { $raises++; $first //= $t0 + $i * $rstep; $last = $t0 + $i * $rstep; }
            $firing += $stride * $rstep if $m;
            $prev = $m;
        }
        if ($raises || $prev) {
            push @rep, { path => $p, title => $title, raises => $raises, firingMinutes => $firing / 60,
                         first => $first, last => $last, stillFiring => _bool($prev) };
            $total_raises += $raises;
        }
    });
    @rep = sort { $b->{raises} <=> $a->{raises} || $b->{firingMinutes} <=> $a->{firingMinutes} } @rep;

    return {
        generated  => time,
        rule       => { %$rule, human => SmokepingModern::AlertRule::human(SmokepingModern::AlertRule::parse($rule->{type}, $rule->{pattern}, $step)) },
        stepSec    => $step + 0,
        targetsChecked => $count,
        firingNow  => \@now,
        replay     => { hours => $replay_h, totalRaises => $total_raises || 0, targets => \@rep },
    };
}

# ---------------------------------------------------------------------------

sub health {
    my $ok = eval { _boot(); 1 } || 0;
    return {
        service  => 'smokeping-modern-api',
        version  => $VERSION,
        ok       => _bool($ok),
        error    => $ok ? undef : "$@",
        config   => $CONF,
        datadir  => $ok ? _datadir() : undef,
        targets  => $ok ? scalar(@{ $_si->fetch_nodes(mode => 'plain') // [] }) : undef,
        alertsDefined => $ok ? [ grep { ref $_cfg->{Alerts}{$_} eq 'HASH' } keys %{ $_cfg->{Alerts} } ] : [],
        generated => time,
    };
}

1;
