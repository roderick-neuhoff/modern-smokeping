package SmokepingModern::AlertRule;

# Human-friendly alert rules <-> SmokePing alert patterns.
#
# SmokePing counts in *poll cycles*; people think in minutes. Every duration
# here is in minutes and is converted with the configured Database step.
#
#   kind     form fields                                  SmokePing pattern
#   ------   ------------------------------------------   ---------------------------------------
#   loss     pct, minutes, clearPct, clearMinutes         ConsecutiveLoss(pctlossraise=>..,stepsraise=>..,
#                                                            pctlossclear=>..,stepsclear=>..)
#   down     pct, minutes                                 type=loss, ">P%" repeated N times
#   latency  ms, minutes                                  CheckLatency(l=>ms,x=>N)
#   shift    ratio (%), currentMinutes, historicMinutes   Avgratio(historic=>H,current=>C,comparator=>'>',percentage=>R)
#   custom   type, pattern                                whatever you wrote
#
# Pure Perl, no SmokePing dependency (unit-testable).

use strict;
use warnings;

our $MAX_CYCLES = 720;    # 2 h at a 10 s step; keeps patterns and the preview sane

sub cycles {
    my ($minutes, $step) = @_;
    $step ||= 300;
    my $n = int(($minutes * 60) / $step + 0.999999);
    $n = 1 if $n < 1;
    $n = $MAX_CYCLES if $n > $MAX_CYCLES;
    return $n;
}

sub minutes_for {
    my ($cycles, $step) = @_;
    $step ||= 300;
    my $m = $cycles * $step / 60;
    return sprintf('%.1f', $m) + 0;      # 1 decimal, trimmed
}

sub _num {
    my ($p, $key, %o) = @_;
    my $v = $p->{$key};
    die { status => 422, error => "$key is required" } unless defined $v && $v =~ /^\s*-?\d+(?:\.\d+)?\s*$/;
    $v += 0;
    die { status => 422, error => "$key must be >= $o{min}" } if defined $o{min} && $v < $o{min};
    die { status => 422, error => "$key must be <= $o{max}" } if defined $o{max} && $v > $o{max};
    return $v;
}

# -> { type, pattern, kind }   (dies with { status, error } on bad input)
sub build {
    my ($p, $step) = @_;
    $p ||= {};
    my $kind = $p->{kind} // '';

    if ($kind eq 'loss') {
        my $pct  = int(_num($p, 'pct', min => 1, max => 100));
        my $mins = _num($p, 'minutes', min => 0);
        my $cpct = defined $p->{clearPct} && length $p->{clearPct} ? int(_num($p, 'clearPct', min => 0, max => 100)) : ($pct > 3 ? 3 : 0);
        my $cmin = defined $p->{clearMinutes} && length $p->{clearMinutes} ? _num($p, 'clearMinutes', min => 0) : ($mins * 2 || 1);
        my ($n, $m) = (cycles($mins, $step), cycles($cmin, $step));
        return { kind => $kind, type => 'matcher',
                 pattern => "ConsecutiveLoss(pctlossraise=>$pct,stepsraise=>$n,pctlossclear=>$cpct,stepsclear=>$m)" };
    }
    if ($kind eq 'down') {
        my $pct  = int(_num($p, 'pct', min => 1, max => 100));
        my $mins = _num($p, 'minutes', min => 0);
        my $n = cycles($mins, $step);
        return { kind => $kind, type => 'loss', pattern => join(',', ('>' . $pct . '%') x $n) };
    }
    if ($kind eq 'latency') {
        my $ms   = int(_num($p, 'ms', min => 1));
        my $mins = _num($p, 'minutes', min => 0);
        return { kind => $kind, type => 'matcher', pattern => "CheckLatency(l=>$ms,x=>" . cycles($mins, $step) . ")" };
    }
    if ($kind eq 'shift') {
        my $ratio = _num($p, 'ratio', min => 101, max => 10000);
        my $cur   = _num($p, 'currentMinutes', min => 0);
        my $hist  = _num($p, 'historicMinutes', min => 0);
        my ($c, $h) = (cycles($cur, $step), cycles($hist, $step));
        $ratio = int($ratio) if $ratio == int($ratio);
        return { kind => $kind, type => 'matcher',
                 pattern => "Avgratio(historic=>$h,current=>$c,comparator=>'>',percentage=>$ratio)" };
    }
    if ($kind eq 'custom') {
        my $type = $p->{type} // '';
        die { status => 422, error => 'type must be loss, rtt or matcher' } unless $type =~ /^(loss|rtt|matcher)$/;
        my $pat = $p->{pattern} // '';
        $pat =~ s/[\r\n]+/ /g; $pat =~ s/^\s+|\s+$//g;
        die { status => 422, error => 'pattern is required' } unless length $pat;
        return { kind => $kind, type => $type, pattern => $pat };
    }
    die { status => 422, error => 'kind must be loss, down, latency, shift or custom' };
}

# existing (type, pattern) -> form parameters; anything unrecognised is "custom"
sub parse {
    my ($type, $pattern, $step) = @_;
    $type //= ''; $pattern //= '';
    $pattern =~ s/^\s+|\s+$//g;

    if ($pattern =~ /^ConsecutiveLoss\(\s*pctlossraise\s*=>\s*(\d+)\s*,\s*stepsraise\s*=>\s*(\d+)\s*,\s*pctlossclear\s*=>\s*(\d+)\s*,\s*stepsclear\s*=>\s*(\d+)\s*\)$/) {
        return { kind => 'loss', pct => $1 + 0, minutes => minutes_for($2, $step),
                 clearPct => $3 + 0, clearMinutes => minutes_for($4, $step) };
    }
    if ($pattern =~ /^CheckLatency\(\s*l\s*=>\s*(\d+)\s*,\s*x\s*=>\s*(\d+)\s*\)$/) {
        return { kind => 'latency', ms => $1 + 0, minutes => minutes_for($2, $step) };
    }
    if ($pattern =~ /^Avgratio\(\s*historic\s*=>\s*(\d+)\s*,\s*current\s*=>\s*(\d+)\s*,\s*comparator\s*=>\s*'>'\s*,\s*percentage\s*=>\s*([\d.]+)\s*\)$/) {
        return { kind => 'shift', ratio => $3 + 0, currentMinutes => minutes_for($2, $step),
                 historicMinutes => minutes_for($1, $step) };
    }
    if ($type eq 'loss' && $pattern =~ /^>(\d+)%(?:,>\1%)*$/) {
        my $pct = $1;
        my $n = () = $pattern =~ /,/g; $n++;
        return { kind => 'down', pct => $pct + 0, minutes => minutes_for($n, $step) };
    }
    return { kind => 'custom', type => $type, pattern => $pattern };
}

sub human {
    my $r = shift;
    my $k = $r->{kind} // 'custom';
    my $m = sub { my $v = shift; $v == 1 ? '1 min' : "$v min" };
    return "loss \x{2265} $r->{pct}% for " . $m->($r->{minutes}) . " (clears below $r->{clearPct}% for " . $m->($r->{clearMinutes}) . ")" if $k eq 'loss';
    return "loss > $r->{pct}% for " . $m->($r->{minutes}) if $k eq 'down';
    return "latency \x{2265} $r->{ms} ms for " . $m->($r->{minutes}) if $k eq 'latency';
    return "latency > $r->{ratio}% of the previous " . $m->($r->{historicMinutes}) . " (over the last " . $m->($r->{currentMinutes}) . ")" if $k eq 'shift';
    return "custom $r->{type}: $r->{pattern}";
}

1;
