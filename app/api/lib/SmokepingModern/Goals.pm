package SmokepingModern::Goals;

# Uptime goals (SLOs): "the WAN group should be 99.9 % available".
#
# A goal is attached to a path - a group ("/WAN"), a single target
# ("/WAN/Quad9") or the whole tree ("/") - and a target availability in percent.
# A path is judged against the most specific goal that covers it, so a group
# goal applies to everything under it unless a target has its own.
#
# Availability here is the report's packet-based figure: 100 % - average loss
# (planned maintenance already excluded). The monthly "downtime budget" is the
# allowed unavailability, e.g. 99.9 % over a 30-day month = 43 min 12 s.
#
# Stored in /config/modern-goals.json. Plain Perl (unit-testable).

use strict;
use warnings;

use JSON::PP ();
use POSIX ();
use SmokepingModern::Events ();

my $J = JSON::PP->new->utf8->canonical(1);

sub file { $ENV{SPM_GOALS_FILE} || SmokepingModern::Events::config_dir() . '/modern-goals.json' }

sub load {
    open my $fh, '<', file() or return [];
    local $/;
    my $raw = <$fh>;
    close $fh;
    my $d = eval { $J->decode($raw) };
    my $g = ref $d eq 'HASH' ? $d->{goals} : $d;
    return ref $g eq 'ARRAY' ? [ grep { ref $_ eq 'HASH' && defined $_->{target} } @$g ] : [];
}

sub save {
    my $goals = shift;
    my $f = file();
    my $tmp = "$f.tmp.$$";
    open my $fh, '>', $tmp or die { status => 500, error => "cannot write $f: $!" };
    print $fh $J->pretty->encode({ goals => $goals });
    close $fh;
    chmod 0644, $tmp;
    rename $tmp, $f or die { status => 500, error => "cannot replace $f: $!" };
    return 1;
}

# '' and '/' both mean "everything"
sub norm_path {
    my $p = shift // '';
    $p =~ s{/+$}{};
    return length $p ? $p : '/';
}

sub normalize {
    my $in = shift;
    die { status => 422, error => 'goal is required' } unless ref $in eq 'HASH';
    my $path = norm_path($in->{path});
    die { status => 422, error => "bad scope '$path'" } unless $path eq '/' || $path =~ m{^(?:/[A-Za-z0-9_-]+)+$};
    my $t = $in->{target};
    die { status => 422, error => 'target must be a number, e.g. 99.9' } unless defined $t && $t =~ /^\s*\d+(?:\.\d+)?\s*$/;
    $t += 0;
    die { status => 422, error => 'target must be at least 50 and below 100 (100 % leaves no downtime budget)' } if $t < 50 || $t >= 100;
    (my $note = $in->{note} // '') =~ s/[\r\n]+/ /g;
    return { path => $path, target => $t, note => substr($note, 0, 200) };
}

# the most specific goal covering $path (a hash) or undef
sub effective {
    my ($path, $goals) = @_;
    $goals ||= load();
    $path = norm_path($path);
    my ($best, $len) = (undef, -1);
    for my $g (@$goals) {
        my $gp = norm_path($g->{path});
        my $covers = $gp eq '/' || $path eq $gp || index($path, "$gp/") == 0;
        next unless $covers;
        my $l = $gp eq '/' ? 0 : length $gp;
        ($best, $len) = ($g, $l) if $l > $len;
    }
    return $best;
}

# calendar month (server time zone) containing $now -> (start, end) epochs
sub month_bounds {
    my $now = shift // time;
    my @lt = localtime $now;
    my $start = POSIX::mktime(0, 0, 0, 1, $lt[4], $lt[5]);
    my $end   = POSIX::mktime(0, 0, 0, 1, $lt[4] + 1, $lt[5]);
    return ($start, $end);
}

# seconds of unavailability a goal allows over $span seconds
sub budget_seconds { my ($target, $span) = @_; return $span * (100 - $target) / 100 }

# used vs allowed, with a straight-line projection to the end of the month
#   -> { budgetSec, usedSec, remainingSec, usedPct, projectedSec, status: ok|at_risk|breached }
sub budget_state {
    my (%a) = @_;                                   # target, availability, observedSec, monthStart, monthEnd, now
    my $span    = $a{monthEnd} - $a{monthStart};
    my $elapsed = $a{now} - $a{monthStart};
    $elapsed = 1 if $elapsed < 1;
    my $budget  = budget_seconds($a{target}, $span);
    my $used    = (100 - $a{availability}) / 100 * $a{observedSec};
    $used = 0 if $used < 0;
    my $frac    = $elapsed / $span;
    my $projected = $frac > 0.02 ? $used / $frac : $used;      # too early in the month to extrapolate
    my $status = $used > $budget ? 'breached'
               : ($used > 0.75 * $budget || $projected > $budget) ? 'at_risk'
               : 'ok';
    return {
        budgetSec    => $budget,
        usedSec      => $used,
        remainingSec => $budget - $used,
        usedPct      => $budget > 0 ? 100 * $used / $budget : 100,
        projectedSec => $projected,
        status       => $status,
    };
}

1;
