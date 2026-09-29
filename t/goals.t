use strict; use warnings;
use FindBin (); use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
use POSIX ();
my $d = tempdir(CLEANUP => 1);
$ENV{SMOKEPING_CONFIG_DIR} = $d;
require SmokepingModern::Goals;
require SmokepingModern::Admin;
my $G = 'SmokepingModern::Goals';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
sub dies { my ($code, $re, $m) = @_; eval { $code->() }; ok(ref $@ eq 'HASH' && $@->{status} == 422 && $@->{error} =~ $re, "$m -> " . (ref $@ ? $@->{error} : "no die $@")) }

my $g = $G->can('normalize')->({ path => '/WAN/', target => '99.9', note => "a\nb" });
ok($g->{path} eq '/WAN' && $g->{target} == 99.9 && $g->{note} eq 'a b', 'normalize trims path, numeric target, one-line note');
ok($G->can('normalize')->({ path => '', target => 99 })->{path} eq '/', 'empty scope = everything');
dies(sub { $G->can('normalize')->({ path => '/x', target => 100 }) }, qr/below 100/, '100 % refused');
dies(sub { $G->can('normalize')->({ path => '/x', target => 20 }) }, qr/at least 50/, 'too low refused');
dies(sub { $G->can('normalize')->({ path => '/x', target => 'abc' }) }, qr/number/, 'non-numeric refused');
dies(sub { $G->can('normalize')->({ path => 'WAN', target => 99 }) }, qr/bad scope/, 'bad scope refused');

my @goals = ({ path => '/', target => 99 }, { path => '/WAN', target => 99.9 }, { path => '/WAN/Quad9', target => 99.99 });
ok($G->can('effective')->('/WAN/Quad9', \@goals)->{target} == 99.99, 'target goal beats group goal');
ok($G->can('effective')->('/WAN/Google', \@goals)->{target} == 99.9, 'group goal covers its children');
ok($G->can('effective')->('/Sites/x', \@goals)->{target} == 99, 'default goal covers the rest');
ok($G->can('effective')->('/WANDER/x', \@goals)->{target} == 99, 'prefix respects path boundaries');
ok($G->can('effective')->('', \@goals)->{target} == 99, 'top-level group uses the default');
ok(!defined $G->can('effective')->('/x', [ { path => '/WAN', target => 99 } ]), 'no goal -> undef');

my $b = $G->can('budget_seconds')->(99.9, 30 * 86400);
ok(abs($b - 2592) < 0.01, '99.9 % of 30 days = 2592 s (43m12s)');

my ($ms, $me) = $G->can('month_bounds')->(POSIX::mktime(0, 0, 12, 18, 8, 126));       # 18 Sep 2026
ok($me - $ms == 30 * 86400, 'September 2026 is 30 days');
my $now = $ms + 15 * 86400;                                                            # half way
my %base = (target => 99.9, monthStart => $ms, monthEnd => $me, now => $now, observedSec => 15 * 86400);
my $st = $G->can('budget_state')->(%base, availability => 99.99);
ok($st->{status} eq 'ok' && abs($st->{usedSec} - 129.6) < 0.5 && $st->{remainingSec} > 2400, 'ok: 99.99 % half way through');
$st = $G->can('budget_state')->(%base, availability => 99.86);
ok($st->{status} eq 'at_risk' && $st->{usedSec} < $st->{budgetSec}, 'at risk: under budget but projected to exceed it (' . sprintf('%.0f/%.0f proj %.0f', @$st{qw(usedSec budgetSec projectedSec)}) . ')');
$st = $G->can('budget_state')->(%base, availability => 99.7);
ok($st->{status} eq 'breached' && $st->{remainingSec} < 0, 'breached: 99.7 % is over the monthly budget');
$st = $G->can('budget_state')->(%base, now => $ms + 3600, observedSec => 3600, availability => 100);
ok($st->{status} eq 'ok' && $st->{usedSec} == 0, 'first hour, perfect: ok, nothing used');
$st = $G->can('budget_state')->(%base, now => $ms + 3600, observedSec => 3600, availability => 90);
ok($st->{status} eq 'ok', 'a bad first hour alone is not extrapolated across the month (' . $st->{status} . ')');
$st = $G->can('budget_state')->(%base, now => $ms + 86400, observedSec => 86400, availability => 95);
ok($st->{status} eq 'breached', 'one day at 95 % blows a 99.9 % monthly budget');

# admin CRUD
my $A = 'SmokepingModern::Admin';
my $r = $A->can('goals_save')->({ path => '/WAN', target => 99.9 });
ok($r->{ok} && @{ $r->{goals} } == 1 && abs($r->{goals}[0]{allowedPerMonthSec} - 2592) < 0.01, 'saved + allowed downtime returned');
$r = $A->can('goals_save')->({ path => '/WAN', target => 99.5 });
ok(@{ $r->{goals} } == 1 && $r->{goals}[0]{target} == 99.5, 'same scope updates in place');
$r = $A->can('goals_save')->({ path => '/', target => 99 });
ok(@{ $r->{goals} } == 2, 'second scope added');
$r = $A->can('goals_delete')->({ path => '/WAN/' });
ok(@{ $r->{goals} } == 1 && $r->{goals}[0]{path} eq '/', 'delete by scope');
eval { $A->can('goals_delete')->({ path => '/nope' }) };
ok(ref $@ && $@->{status} == 404, 'delete unknown -> 404');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
