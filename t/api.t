# Api.pm against stubbed SmokePing/RRDs (t/lib): report, alert preview,
# maintenance, goals, stale detection, delivery status, metrics, events.
use strict; use warnings;
use FindBin ();
use lib "$FindBin::Bin/lib", "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
my $d = tempdir(CLEANUP => 1);
mkdir "$d/$_" for qw(log data data/Sites cache);
for (qw(Sites/Google Sites/Cf Top)) { open my $f, '>', "$d/data/$_.rrd" or die; close $f }
$ENV{SMOKEPING_CONFIG_DIR} = $d;
$ENV{SMOKEPING_LOG}        = "$d/log/smokeping.log";
$ENV{SMOKEPING_CONF}       = $0;                 # any readable file: Info is stubbed
$ENV{SPM_TEST_DATADIR}     = "$d/data";
$ENV{SPM_CACHE_DIR}        = "$d/cache";
require SmokepingModern::Api;
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
my $A = 'SmokepingModern::Api';

# --- report ------------------------------------------------------------------
my $r = $A->can('report')->({ range => '24h' });
ok($r->{summary}{targets} == 3, 'report: 3 targets');
ok(abs($r->{targets}[0]{availability} - 99.9275) < 0.001, "report: availability = 100 - mean loss ($r->{targets}[0]{availability})");
ok($r->{targets}[0]{downtimeSec} == 0 && $r->{targets}[0]{lossMinutes} > 0, 'report: 20 % loss is loss-minutes, not full outage');
ok((grep { $_->{path} eq '/Sites' } @{ $r->{groups} }) && (grep { $_->{path} eq '' } @{ $r->{groups} }), 'report: group roll-up incl. top level');
ok($r->{targets}[0]{worstHour} && $r->{targets}[0]{worstHour}{lossPct} > 0, 'report: worst hour found');

# --- alert preview -------------------------------------------------------------
my $p = $A->can('alertpreview')->({ kind => 'loss', pct => 10, minutes => 1 });
ok($p->{rule}{pattern} eq 'ConsecutiveLoss(pctlossraise=>10,stepsraise=>6,pctlossclear=>3,stepsclear=>12)', 'preview: pattern built');
ok($p->{replay}{totalRaises} == 3 && @{ $p->{firingNow} } == 0, 'preview: replay sees the burst once per target, not firing now');
eval { $A->can('alertpreview')->({ kind => 'latency', ms => 300, minutes => 1 }) };
ok(ref $@ && $@->{status} == 422, 'preview: a pattern SmokePing rejects -> 422');

# --- maintenance ------------------------------------------------------------------
SmokepingModern::Maintenance::save([ { id => 'm1', title => 'Swap', mode => 'once', start => time - 300, end => time + 3600, paths => ['/Sites'] } ]);
my $s = $A->can('summary')->({});
my ($g)  = grep { $_->{path} eq '/Sites/Google' } @{ $s->{nodes} };
my ($q9) = grep { $_->{path} eq '/Top' } @{ $s->{nodes} };
ok($g->{maintenance} && $g->{maintenance}{title} eq 'Swap' && !$q9->{maintenance}, 'summary: maintenance flagged on covered targets only');
ok($s->{counts}{maintenance} == 2 && @{ $s->{maintenance} } == 1, 'summary: maintenance counted + active list');
my $rm = $A->can('report')->({ range => '24h' });
my ($rg) = grep { $_->{path} eq '/Sites/Google' } @{ $rm->{targets} };
ok($rg->{maintenanceSec} > 0 && $rg->{availability} > $r->{targets}[0]{availability}, 'report: in-window loss is excluded');
SmokepingModern::Maintenance::save([]);

# --- goals ----------------------------------------------------------------------
SmokepingModern::Goals::save([ { path => '/Sites', target => 99.95 }, { path => '/', target => 99 } ]);
my $rgo = $A->can('report')->({ range => '24h' });
my %t = map { $_->{path} => $_ } @{ $rgo->{targets} };
ok($t{'/Sites/Google'}{goal} == 99.95 && !$t{'/Sites/Google'}{meets} && $t{'/Top'}{goal} == 99 && $t{'/Top'}{meets}, 'goals: most specific goal + pass/fail');
ok($t{'/Top'}{budget} && $t{'/Top'}{budget}{budgetSec} > 0, 'goals: monthly budget computed');
ok($rgo->{summary}{goalsTotal} == 3 && $rgo->{summary}{goalsMet} == 1, 'goals: summary 1 / 3');
SmokepingModern::Goals::save([]);

# --- stale / polling ---------------------------------------------------------------
$RRDs::LAST = time - 3600;
$s = $A->can('summary')->({});
ok($s->{polling}{stopped} && $s->{polling}{staleTargets} == 3, 'summary: polling stopped when no rrd moved for an hour');
ok((grep { $_->{stale} && $_->{severity} eq 'unknown' } @{ $s->{nodes} }) == 3, 'summary: stale targets show as unknown, not ok');
$RRDs::LAST = undef;
$s = $A->can('summary')->({});
ok(!$s->{polling}{stopped} && $s->{polling}{staleTargets} == 0, 'summary: fresh rrds -> polling fine');

# --- delivery -------------------------------------------------------------------------
SmokepingModern::Delivery::record('webhook', 0, 'HTTP 000 (curl rc=7)');
$s = $A->can('summary')->({});
ok(@{ $s->{delivery} } == 1 && $s->{delivery}[0]{channel} eq 'webhook' && $s->{delivery}[0]{lastError} =~ /rc=7/, 'summary: failing channel reported');

# --- metrics ---------------------------------------------------------------------------
my $m = $A->can('metrics_text')->();
ok($m =~ /^smokeping_modern_up 1$/m && $m =~ /^smokeping_target_loss_percent\{/m, 'metrics: basic series');
ok($m =~ /^smokeping_polling_stopped 0$/m && $m =~ /^smokeping_target_stale\{/m, 'metrics: polling + stale');
ok($m =~ /^smokeping_notification_channel_failing\{channel="webhook"\} 1$/m, 'metrics: failing channel');
SmokepingModern::Delivery::record('webhook', 1, 'HTTP 204');
$s = $A->can('summary')->({});
ok(@{ $s->{delivery} } == 0, 'summary: a successful send clears the failure');

# --- events -----------------------------------------------------------------------------
my $e = $A->can('events')->({});
ok(defined $e->{total} && ref $e->{incidents} eq 'ARRAY', 'events: shape');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
