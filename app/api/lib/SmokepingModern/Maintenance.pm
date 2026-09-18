package SmokepingModern::Maintenance;

# Planned-maintenance windows.
#
# While a window covers a target:
#   * alert notifications for it (webhooks + e-mail) are suppressed
#   * the dashboard / wall / alerts page show it as "in maintenance", not as a problem
#   * its outage time is left out of the availability report
# SmokePing itself keeps evaluating alerts as usual - only the noise is removed.
#
# Windows live in /config/modern-maintenance.json:
#   { id, title, note, paths:[], enabled,
#     mode:"once",   start, end                        (epoch seconds)
#     mode:"weekly", days:[0-6 (0=Sunday)], time:"HH:MM", durationMin }
# `paths` empty = every target; otherwise a target or a whole group ("/WAN").
# Weekly times are in the container's timezone (TZ).
#
# Plain Perl (no SmokePing dependency) so the notifier scripts can use it.

use strict;
use warnings;

use JSON::PP ();
use POSIX ();
use Fcntl qw(:flock);
use SmokepingModern::Events ();

my $J = JSON::PP->new->utf8->canonical(1);

our $MAX_ONCE_SEC   = 60 * 86400;
our $MAX_WEEKLY_MIN = 2880;

sub file { $ENV{SPM_MAINT_FILE} || SmokepingModern::Events::config_dir() . '/modern-maintenance.json' }

sub load {
    my $f = file();
    open my $fh, '<', $f or return [];
    local $/;
    my $raw = <$fh>;
    close $fh;
    my $d = eval { $J->decode($raw) };
    my $w = ref $d eq 'HASH' ? $d->{windows} : $d;
    return ref $w eq 'ARRAY' ? [ grep { ref $_ eq 'HASH' } @$w ] : [];
}

sub save {
    my $windows = shift;
    my $f = file();
    my $tmp = "$f.tmp.$$";
    open my $fh, '>', $tmp or die { status => 500, error => "cannot write $f: $!" };
    print $fh $J->pretty->encode({ windows => $windows });
    close $fh;
    chmod 0644, $tmp;
    rename $tmp, $f or die { status => 500, error => "cannot replace $f: $!" };
    return 1;
}

# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

sub _int {
    my ($v, $what) = @_;
    die { status => 422, error => "$what must be a number" } unless defined $v && $v =~ /^\s*\d+(?:\.\d+)?\s*$/;
    return int($v);
}

# raw form input -> normalised window (dies { status, error } on bad input)
sub normalize {
    my ($in, $now) = @_;
    $now //= time;
    die { status => 422, error => 'window is required' } unless ref $in eq 'HASH';
    my %w;
    ($w{title} = $in->{title} // '') =~ s/[\r\n]+/ /g;
    $w{title} =~ s/^\s+|\s+$//g;
    $w{title} = 'Maintenance' unless length $w{title};
    $w{title} = substr $w{title}, 0, 80;
    ($w{note} = $in->{note} // '') =~ s/[\r\n]+/ /g;
    $w{note} = substr $w{note}, 0, 300;
    $w{enabled} = (defined $in->{enabled} && !$in->{enabled}) ? JSON::PP::false : JSON::PP::true;

    my @paths = ref $in->{paths} eq 'ARRAY' ? @{ $in->{paths} } : ();
    my %seen;
    for my $p (@paths) {
        $p = '' unless defined $p;
        $p =~ s{/+$}{};
        die { status => 422, error => "bad scope '$p'" } unless $p =~ m{^(?:/[A-Za-z0-9_-]+)+$} || $p eq '';
        $seen{ length $p ? $p : '/' } = 1 if length $p;
    }
    $w{paths} = [ sort keys %seen ];

    my $mode = $in->{mode} // 'once';
    if ($mode eq 'once') {
        my ($s, $e) = (_int($in->{start}, 'start'), _int($in->{end}, 'end'));
        die { status => 422, error => 'end must be after start' } unless $e > $s;
        die { status => 422, error => 'a one-off window can be at most 60 days - use a weekly window for recurring work' } if $e - $s > $MAX_ONCE_SEC;
        @w{qw(mode start end)} = ('once', $s, $e);
    }
    elsif ($mode eq 'weekly') {
        my %d = map { $_ => 1 } grep { /^[0-6]$/ } @{ ref $in->{days} eq 'ARRAY' ? $in->{days} : [] };
        die { status => 422, error => 'pick at least one weekday' } unless %d;
        my $time = $in->{time} // '';
        die { status => 422, error => 'time must look like 03:30' } unless $time =~ /^([01]?\d|2[0-3]):([0-5]\d)$/;
        my $dur = _int($in->{durationMin}, 'duration');
        die { status => 422, error => "duration must be 1-$MAX_WEEKLY_MIN minutes" } if $dur < 1 || $dur > $MAX_WEEKLY_MIN;
        @w{qw(mode days time durationMin)} = ('weekly', [ sort { $a <=> $b } keys %d ], sprintf('%02d:%02d', $1, $2), $dur);
    }
    else {
        die { status => 422, error => "mode must be 'once' or 'weekly'" };
    }
    return \%w;
}

# ---------------------------------------------------------------------------
# time arithmetic
# ---------------------------------------------------------------------------

# every [start, end) occurrence of a window overlapping [$from, $to)
sub window_intervals {
    my ($w, $from, $to) = @_;
    return () if defined $w->{enabled} && !$w->{enabled};
    if (($w->{mode} // 'once') eq 'once') {
        return ($w->{end} > $from && $w->{start} < $to) ? ([ $w->{start} + 0, $w->{end} + 0 ]) : ();
    }
    my ($hh, $mm) = split /:/, ($w->{time} // '00:00');
    my %day = map { $_ => 1 } @{ $w->{days} || [] };
    my $dur = ($w->{durationMin} || 0) * 60;
    my @out;
    my @lt = localtime($from - $dur);
    my ($y, $mo, $d0) = ($lt[5], $lt[4], $lt[3]);
    for (my $i = 0; $i < 4000; $i++) {                         # >10 years of days is more than enough
        my $noon = POSIX::mktime(0, 0, 12, $d0 + $i, $mo, $y);
        last if !defined $noon;
        my @n = localtime($noon);
        my $s = POSIX::mktime(0, $mm + 0, $hh + 0, $n[3], $n[4], $n[5]);
        last if !defined $s || $s >= $to;
        next unless $day{ $n[6] };
        my $e = $s + $dur;
        push @out, [ $s, $e ] if $e > $from;
    }
    return @out;
}

sub _applies {
    my ($w, $path) = @_;
    my $paths = $w->{paths} || [];
    return 1 unless @$paths;
    for my $p (@$paths) {
        return 1 if $p eq '/' || $path eq $p || index($path, "$p/") == 0;
    }
    return 0;
}

sub _brief { my ($w, $iv) = @_; return { id => $w->{id}, title => $w->{title}, note => $w->{note}, start => $iv->[0], end => $iv->[1], until => $iv->[1] } }

# intervals [start,end,windowbrief] applying to a target path within [$from,$to)
sub intervals {
    my ($path, $from, $to, $windows) = @_;
    $windows ||= load();
    my @out;
    for my $w (@$windows) {
        next unless _applies($w, $path);
        push @out, map { [ $_->[0], $_->[1], _brief($w, $_) ] } window_intervals($w, $from, $to);
    }
    return sort { $a->[0] <=> $b->[0] } @out;
}

# the window covering $path at time $t (or undef)
sub covers {
    my ($path, $t, $windows) = @_;
    $t //= time;
    $windows ||= load();
    for my $iv (intervals($path, $t - 3 * 86400, $t + 1, $windows)) {
        return $iv->[2] if $iv->[0] <= $t && $t < $iv->[1];
    }
    return undef;
}

# windows in effect right now (regardless of scope), for banners
sub active {
    my ($now, $windows) = @_;
    $now //= time;
    $windows ||= load();
    my @out;
    for my $w (@$windows) {
        for my $iv (window_intervals($w, $now - 3 * 86400, $now + 1)) {
            next unless $iv->[0] <= $now && $now < $iv->[1];
            push @out, { %{ _brief($w, $iv) }, paths => $w->{paths} || [], mode => $w->{mode} };
            last;
        }
    }
    return @out;
}

# for the settings list: active / upcoming / ended
sub state_of {
    my ($w, $now) = @_;
    $now //= time;
    my ($cur) = grep { $_->[0] <= $now && $now < $_->[1] } window_intervals($w, $now - 3 * 86400, $now + 1);
    return { status => 'active', until => $cur->[1], since => $cur->[0] } if $cur;
    my ($next) = sort { $a->[0] <=> $b->[0] } grep { $_->[0] > $now } window_intervals($w, $now, $now + 400 * 86400);
    return { status => 'upcoming', next => $next->[0], nextEnd => $next->[1] } if $next;
    return { status => 'ended' };
}

# ---------------------------------------------------------------------------
# notification gate (used by bin/notify, bin/graph-send, bin/maint-check)
# ---------------------------------------------------------------------------

# Should this alert notification be dropped? Returns the window title or undef.
# A recovery is dropped only when the outage *began* inside a window, so nobody
# gets "back after 3m" for something they were never told about - but a real
# outage that started before the window still announces its recovery.
sub suppress_alert {
    my ($alert, $what, $target, $now) = @_;
    $now //= time;
    return undef unless defined $target && length $target;
    (my $line = $target) =~ s/\s.*$//;
    my $path = SmokepingModern::Events::target_to_path($line);
    my $t = $now;
    if (($what // '') eq 'cleared') {
        my ($start) = SmokepingModern::Events::outage_times($alert, $line);
        $t = $start if defined $start;
    }
    my $w = covers($path, $t);
    return $w ? $w->{title} : undef;
}

# same, from a SmokePing alert mail subject:  [SmokeAlert] <alert> was raised on <target>
sub suppress_message {
    my ($subject, $now) = @_;
    return undef unless defined $subject
        && $subject =~ /^\[SmokeAlert\]\s+(\S+)\s+(was raised|was cleared|is active)\s+on\s+(\S+)/;
    my ($alert, $what, $target) = ($1, $2, $3);
    $what = $what eq 'was cleared' ? 'cleared' : 'raised';
    return suppress_alert($alert, $what, $target, $now);
}

1;
