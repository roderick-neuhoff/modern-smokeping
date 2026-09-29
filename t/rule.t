use strict; use warnings;
use FindBin (); use lib "$FindBin::Bin/../app/api/lib";
use SmokepingModern::AlertRule;
my $R = 'SmokepingModern::AlertRule';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
sub dies_422 { my ($code, $m) = @_; eval { $code->() }; ok(ref $@ eq 'HASH' && $@->{status} == 422, "$m -> 422" . (ref $@ ? " ($@->{error})" : " (no die: $@)")) }

ok($R->can('cycles')->(1, 10)  == 6,   '1 min @10s = 6 cycles');
ok($R->can('cycles')->(3, 10)  == 18,  '3 min @10s = 18 cycles');
ok($R->can('cycles')->(3, 300) == 1,   '3 min @300s = 1 cycle (rounds up, min 1)');
ok($R->can('cycles')->(0, 10)  == 1,   '0 min -> 1 cycle');
ok($R->can('cycles')->(999999, 10) == 720, 'capped at 720');

my $b;
$b = $R->can('build')->({ kind => 'loss', pct => 25, minutes => 1, clearPct => 3, clearMinutes => 2 }, 10);
ok($b->{type} eq 'matcher' && $b->{pattern} eq 'ConsecutiveLoss(pctlossraise=>25,stepsraise=>6,pctlossclear=>3,stepsclear=>12)', "loss pattern: $b->{pattern}");
$b = $R->can('build')->({ kind => 'down', pct => 90, minutes => 1 }, 10);
ok($b->{type} eq 'loss' && $b->{pattern} eq '>90%,>90%,>90%,>90%,>90%,>90%', 'down pattern (6x)');
$b = $R->can('build')->({ kind => 'latency', ms => 300, minutes => 3 }, 10);
ok($b->{pattern} eq 'CheckLatency(l=>300,x=>18)', 'latency pattern');
$b = $R->can('build')->({ kind => 'shift', ratio => 200, currentMinutes => 3, historicMinutes => 10 }, 10);
ok($b->{pattern} eq "Avgratio(historic=>60,current=>18,comparator=>'>',percentage=>200)", 'shift pattern');
$b = $R->can('build')->({ kind => 'custom', type => 'rtt', pattern => ">0.5,>0.5" }, 10);
ok($b->{type} eq 'rtt' && $b->{pattern} eq '>0.5,>0.5', 'custom passthrough');
$b = $R->can('build')->({ kind => 'loss', pct => 10, minutes => 3 }, 10);
ok($b->{pattern} =~ /pctlossclear=>3,stepsclear=>36/, "loss defaults: clear 3% for 2x window ($b->{pattern})");

dies_422(sub { $R->can('build')->({ kind => 'loss', pct => 0, minutes => 1 }, 10) }, 'pct 0');
dies_422(sub { $R->can('build')->({ kind => 'loss', pct => 'abc', minutes => 1 }, 10) }, 'pct not a number');
dies_422(sub { $R->can('build')->({ kind => 'latency', minutes => 1 }, 10) }, 'missing ms');
dies_422(sub { $R->can('build')->({ kind => 'shift', ratio => 100, currentMinutes => 1, historicMinutes => 5 }, 10) }, 'ratio must exceed 100');
dies_422(sub { $R->can('build')->({ kind => 'nope' }, 10) }, 'unknown kind');
dies_422(sub { $R->can('build')->({ kind => 'custom', type => 'x', pattern => 'y' }, 10) }, 'custom bad type');

# round trips: build -> parse -> build gives the same pattern
for my $p (
    { kind => 'loss', pct => 10, minutes => 3, clearPct => 3, clearMinutes => 5 },
    { kind => 'down', pct => 90, minutes => 1 },
    { kind => 'latency', ms => 300, minutes => 3 },
    { kind => 'shift', ratio => 200, currentMinutes => 3, historicMinutes => 10 },
) {
    my $one = $R->can('build')->($p, 10);
    my $par = $R->can('parse')->($one->{type}, $one->{pattern}, 10);
    my $two = $R->can('build')->($par, 10);
    ok($par->{kind} eq $p->{kind} && $one->{pattern} eq $two->{pattern}, "round trip $p->{kind}: $one->{pattern}");
}
# the sample Alerts shipped in config-sample must all be understood (none should fall back to custom)
my %sample = (
    hostdown     => ['loss',    '>90%,>90%,>90%,>90%,>90%,>90%'],
    majorloss    => ['matcher', 'ConsecutiveLoss(pctlossraise=>25,stepsraise=>6,pctlossclear=>3,stepsclear=>12)'],
    lossdetect   => ['matcher', 'ConsecutiveLoss(pctlossraise=>10,stepsraise=>18,pctlossclear=>3,stepsclear=>30)'],
    latencyhigh  => ['matcher', 'CheckLatency(l=>300,x=>18)'],
    latencyshift => ['matcher', "Avgratio(historic=>60,current=>18,comparator=>'>',percentage=>200)"],
);
for my $n (sort keys %sample) {
    my $par = $R->can('parse')->(@{ $sample{$n} }, 10);
    ok($par->{kind} ne 'custom', "sample '$n' parses as '$par->{kind}': " . $R->can('human')->($par));
}
my $c = $R->can('parse')->('matcher', 'Median(old=>5,new=>3,diff=>0.1)', 10);
ok($c->{kind} eq 'custom' && $c->{pattern} =~ /^Median/, 'unknown matcher stays custom');
print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
