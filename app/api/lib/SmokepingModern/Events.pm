package SmokepingModern::Events;

# Persistent alert history for SmokePing (which has no alert database).
#
# SmokePing writes  "Alert <name> was raised|was cleared|is active for <line> ..."
# to its log (--logfile, see the svc-smokeping override). This module tails that
# log incrementally into an append-only JSONL store on the /config volume, so:
#   * history survives log rotation / truncation
#   * raise/clear events can be paired into *incidents* with durations
#   * the notifier / mailer can tell "back after 4m12s"
#
# No SmokePing or RRD dependency - plain Perl, unit-testable on its own.

use strict;
use warnings;

use Fcntl qw(:flock SEEK_SET);
use JSON::PP ();
use POSIX ();

my $J = JSON::PP->new->utf8->canonical(1);

sub config_dir { $ENV{SMOKEPING_CONFIG_DIR} || '/config' }
sub store_file { $ENV{SPM_EVENTS_STORE} || config_dir() . '/modern-events.jsonl' }
sub state_file { $ENV{SPM_EVENTS_STATE} || config_dir() . '/modern-events.state' }

# a level-triggered alert logs "is active" every cycle and never logs a clear;
# consider it over once it has not been seen for this long
our $LEVEL_GRACE = 180;
our $ROTATE_AT   = 10 * 1024 * 1024;

sub log_candidates {
    return grep { defined $_ && length $_ } (
        $ENV{SMOKEPING_LOG},
        config_dir() . '/log/smokeping.log',
        config_dir() . '/log/smokeping/current',
        '/var/log/smokeping/current',
        '/var/log/smokeping.log',
    );
}

sub log_file {
    my @c = log_candidates();
    my ($f) = grep { -s $_ } @c;
    return $f;
}

# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

my %MON = qw(Jan 0 Feb 1 Mar 2 Apr 3 May 4 Jun 5 Jul 6 Aug 7 Sep 8 Oct 9 Nov 10 Dec 11);

sub parse_ts {
    my $line = shift;
    if ($line =~ /^\@(\d{9,})/) { return $1 + 0 }
    if ($line =~ /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/) {
        return POSIX::mktime($6, $5, $4, $3, $2 - 1, $1 - 1900);
    }
    # perl localtime(): "Sun Sep  7 22:40:01 2026 - ..."
    if ($line =~ /^\w{3}\s+(\w{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})/ && defined $MON{$1}) {
        return POSIX::mktime($5, $4, $3, $2, $MON{$1}, $6 - 1900);
    }
    # classic syslog: "Sep  7 22:40:01" (no year)
    if ($line =~ /^(\w{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)/ && defined $MON{$1}) {
        my @now = localtime;
        return POSIX::mktime($5, $4, $3, $2, $MON{$1}, $now[5]);
    }
    return undef;
}

# -> { t, alert, what => raised|cleared|active, target } or undef
sub parse_line {
    my $line = shift;
    return undef unless defined $line
        && $line =~ /Alert\s+(\S+)\s+(was raised|was cleared|is active)\s+for\s+(\S+)/;
    my ($alert, $what, $target) = ($1, $2, $3);
    my $t = parse_ts($line);
    return undef unless defined $t;
    return { t => $t, alert => $alert, target => $target,
             what => ($what eq 'was raised' ? 'raised' : $what eq 'was cleared' ? 'cleared' : 'active') };
}

sub key { return $_[0] . '|' . $_[1] }

# dotted SmokePing "line" (Sites.Google) -> tree path (/Sites/Google)
sub target_to_path {
    my $t = shift // '';
    $t =~ s/\s.*$//;                 # "[from slave]" suffix
    $t =~ s/\./\//g;
    return "/$t";
}

# ---------------------------------------------------------------------------
# ingest: log -> store
# ---------------------------------------------------------------------------

sub _read_state {
    my $fh = shift;
    seek $fh, 0, SEEK_SET;
    local $/;
    my $raw = <$fh>;
    my $s = eval { $J->decode($raw) } if defined $raw && length $raw;
    return ref $s eq 'HASH' ? $s : {};
}

sub _write_state {
    my ($fh, $s) = @_;
    seek $fh, 0, SEEK_SET;
    truncate $fh, 0;
    print $fh $J->encode($s);
    $fh->flush;
}

# Reads any new bytes of the log, appends new transition events to the store.
# Returns the number of events added. Cheap when nothing changed (one stat).
sub ingest {
    my $log = log_file() or return 0;
    my @st = stat $log or return 0;
    my ($ino, $size) = ($st[1], $st[7]);

    open my $sfh, '+>>', state_file() or return 0;
    unless (flock $sfh, LOCK_EX | LOCK_NB) {        # someone else is ingesting right now
        close $sfh;
        return 0;
    }
    my $s = _read_state($sfh);
    $s->{open}   ||= {};
    $s->{active} ||= {};

    my $same_file = defined $s->{ino} && $s->{ino} == $ino && ($s->{file} // '') eq $log;
    my $off = ($same_file && defined $s->{offset} && $s->{offset} <= $size) ? $s->{offset} : 0;

    my @out;
    if ($off < $size) {
        open my $lfh, '<', $log or do { close $sfh; return 0 };
        seek $lfh, $off, SEEK_SET;
        my $want = $size - $off;
        $want = 8 * 1024 * 1024 if $want > 8 * 1024 * 1024;
        my $buf = '';
        read $lfh, $buf, $want;
        close $lfh;
        # only whole lines; leave a partial trailing line for next time
        my $end = rindex $buf, "\n";
        my $used = $end < 0 ? 0 : $end + 1;
        my $chunk = substr $buf, 0, $used;
        $off += $used;

        for my $line (split /\n/, $chunk) {
            my $e = parse_line($line) or next;
            my $k = key($e->{alert}, $e->{target});
            if ($e->{what} eq 'raised') {
                next if defined $s->{open}{$k};          # duplicate raise (daemon restart)
                $s->{open}{$k} = $e->{t};
                delete $s->{active}{$k};
                push @out, { t => $e->{t}, alert => $e->{alert}, target => $e->{target}, event => 'raised' };
            }
            elsif ($e->{what} eq 'cleared') {
                delete $s->{active}{$k};
                my $start = delete $s->{open}{$k};
                push @out, { t => $e->{t}, alert => $e->{alert}, target => $e->{target}, event => 'cleared',
                             (defined $start ? (start => $start) : ()) };
            }
            else {                                       # level-triggered "is active"
                if (!defined $s->{open}{$k}) {
                    $s->{open}{$k} = $e->{t};
                    push @out, { t => $e->{t}, alert => $e->{alert}, target => $e->{target}, event => 'raised', level => 1 };
                }
                $s->{active}{$k} = $e->{t};
            }
        }
    }

    # a level-triggered alert that stopped being reported has ended
    if ($off >= $size) {
        my $now = time;
        for my $k (keys %{ $s->{active} }) {
            my $last = $s->{active}{$k};
            next unless $now - $last > $LEVEL_GRACE;
            my ($alert, $target) = split /\|/, $k, 2;
            my $start = delete $s->{open}{$k};
            delete $s->{active}{$k};
            push @out, { t => $last, alert => $alert, target => $target, event => 'cleared', level => 1,
                         (defined $start ? (start => $start) : ()) };
        }
    }

    if (@out) {
        if (open my $ofh, '>>', store_file()) {
            flock $ofh, LOCK_EX;
            print $ofh $J->encode($_), "\n" for @out;
            close $ofh;
        }
    }
    $s->{file} = $log; $s->{ino} = $ino; $s->{offset} = $off;
    _write_state($sfh, $s);

    # keep the live log small: once fully ingested, roll it aside
    if ($off >= $size && $size > $ROTATE_AT) {
        rename $log, "$log.1" and do { $s->{offset} = 0; $s->{ino} = undef; _write_state($sfh, $s) };
    }
    close $sfh;
    return scalar @out;
}

# After the store was replaced from a backup: treat the current log as already
# consumed and re-derive which incidents are still open, so the next ingest
# neither replays the log into duplicates nor forgets an open incident.
sub rebuild_state {
    my ($ino, $size) = (undef, 0);
    my $log = log_file();
    if ($log && (my @st = stat $log)) { ($ino, $size) = ($st[1], $st[7]) }
    my %open;
    for my $e (@{ read_store() }) {
        my $k = key($e->{alert}, $e->{target});
        if ($e->{event} eq 'raised') { $open{$k} //= $e->{t} }
        elsif ($e->{event} eq 'cleared') { delete $open{$k} }
    }
    open my $sfh, '+>>', state_file() or return 0;
    flock $sfh, LOCK_EX;
    _write_state($sfh, { file => $log, ino => $ino, offset => $size, open => \%open, active => {} });
    close $sfh;
    return 1;
}

# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------

# chronological list of stored events (optionally only t >= since)
sub read_store {
    my (%o) = @_;
    my $since = $o{since} // 0;
    open my $fh, '<', store_file() or return [];
    my @ev;
    while (my $line = <$fh>) {
        my $e = eval { $J->decode($line) } or next;
        next unless ref $e eq 'HASH' && defined $e->{t};
        next if $e->{t} < $since && !$o{keep_open};
        push @ev, $e;
    }
    close $fh;
    return \@ev;
}

# Pair raised -> cleared per (alert,target). Returns chronological incidents:
#   { alert, target, path, start, end|undef, durationSec, open, level }
sub incidents {
    my ($events, $now) = @_;
    $now //= time;
    my (%open, @done);
    for my $e (@$events) {
        my $k = key($e->{alert}, $e->{target});
        if ($e->{event} eq 'raised') {
            next if $open{$k};
            $open{$k} = { alert => $e->{alert}, target => $e->{target}, path => target_to_path($e->{target}),
                          start => $e->{t}, level => ($e->{level} ? 1 : 0) };
        } elsif ($e->{event} eq 'cleared') {
            my $o = delete $open{$k};
            if ($o) {
                $o->{end} = $e->{t};
                $o->{durationSec} = $e->{t} - $o->{start};
                $o->{open} = 0;
                push @done, $o;
            } elsif (defined $e->{start}) {
                push @done, { alert => $e->{alert}, target => $e->{target}, path => target_to_path($e->{target}),
                              start => $e->{start}, end => $e->{t}, durationSec => $e->{t} - $e->{start},
                              open => 0, level => ($e->{level} ? 1 : 0) };
            }
        }
    }
    for my $o (values %open) {
        $o->{end} = undef; $o->{durationSec} = $now - $o->{start}; $o->{open} = 1;
        push @done, $o;
    }
    return [ sort { $a->{start} <=> $b->{start} } @done ];
}

# ---------------------------------------------------------------------------
# helpers for scripts (notify / graph-send): how long did that outage last?
# Works straight from the log tail, because SmokePing logs the transition
# *before* it sends the notification.
# ---------------------------------------------------------------------------

sub outage_duration {
    my ($start, $end) = outage_times(@_);
    return defined $start && defined $end ? $end - $start : undef;
}

# (start, end) epoch of the most recent completed outage of this alert+target
sub outage_times {
    my ($alert, $target) = @_;
    my $log = log_file();
    if ($log && (my @st = stat $log) && open my $fh, '<', $log) {
        my $take = 2 * 1024 * 1024;
        seek $fh, ($st[7] > $take ? $st[7] - $take : 0), SEEK_SET;
        my ($start, $found_s, $found_e);
        while (my $line = <$fh>) {
            my $e = parse_line($line) or next;
            next unless $e->{alert} eq $alert && $e->{target} eq $target;
            if ($e->{what} eq 'raised' || $e->{what} eq 'active') { $start = $e->{t} unless defined $start; }
            elsif ($e->{what} eq 'cleared') {
                ($found_s, $found_e) = ($start, $e->{t}) if defined $start;
                $start = undef;
            }
        }
        close $fh;
        return ($found_s, $found_e) if defined $found_s;
    }

    # not in the log tail (rotated away): the persistent store remembers it
    my ($ls, $le);
    for my $e (@{ read_store() }) {
        next unless $e->{alert} eq $alert && $e->{target} eq $target && $e->{event} eq 'cleared' && defined $e->{start};
        ($ls, $le) = ($e->{start}, $e->{t});
    }
    return ($ls, $le);
}

sub fmt_duration {
    my $s = shift;
    return '?' unless defined $s;
    $s = int($s + 0.5);
    return "${s}s" if $s < 60;
    my ($d, $h, $m) = (int($s / 86400), int($s % 86400 / 3600), int($s % 3600 / 60));
    my $sec = $s % 60;
    return sprintf('%dm%02ds', $m, $sec) if $s < 3600;
    return sprintf('%dh%02dm', $h + $d * 24, $m) if $s < 86400;
    return sprintf('%dd %dh', $d, $h);
}

1;
