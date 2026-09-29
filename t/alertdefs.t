use strict; use warnings;
use FindBin (); use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
use JSON::PP;
my $d = tempdir(CLEANUP => 1);
$ENV{SMOKEPING_CONFIG_DIR} = $d;
require SmokepingModern::Admin;
no warnings 'redefine';
*SmokepingModern::Admin::_check_candidate = sub { { ok => \1, rc => 0, output => '' } };
*SmokepingModern::Admin::_hup = sub { { ok => \1 } };
my $A = 'SmokepingModern::Admin';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
sub slurp { open my $f, '<', $_[0] or return; local $/; <$f> }
sub spew  { open my $f, '>', $_[0] or die; print $f $_[1]; close $f }

spew("$d/Database", "*** Database ***\nstep = 10\npings = 20\n");
spew("$d/Targets", "*** Targets ***\nprobe = FPing\nalerts = hostdown\n\n+ Sites\nmenu = Sites\n\n++ Google\nmenu = Google\nhost = 8.8.8.8\nalerts = lossdetect,hostdown\n");
my $sample = slurp("$FindBin::Bin/../config-sample/Alerts");
spew("$d/Alerts", $sample);

my $g = $A->can('alertdefs_get')->();
ok($g->{stepSec} == 10, 'step 10');
ok(@{ $g->{alerts} } == 5, '5 alerts parsed');
my %by = map { $_->{name} => $_ } @{ $g->{alerts} };
ok($by{hostdown}{rule}{kind} eq 'down' && $by{hostdown}{rule}{minutes} == 1, 'hostdown = down 1 min');
ok($by{latencyhigh}{rule}{kind} eq 'latency' && $by{latencyhigh}{rule}{ms} == 300, 'latencyhigh parsed');
ok($by{hostdown}{edgetrigger} && ${ $by{hostdown}{edgetrigger} } == 1, 'edgetrigger yes');
ok($by{hostdown}{priority} == 1, 'priority');
ok(join(',', sort @{ $by{hostdown}{usedBy} }) eq '(top level),/Sites/Google', 'hostdown usedBy: ' . join(',', @{ $by{hostdown}{usedBy} }));
ok(join(',', @{ $by{lossdetect}{usedBy} }) eq '/Sites/Google', 'lossdetect usedBy');
ok(!@{ $by{majorloss}{usedBy} }, 'majorloss unused');

# edit in place: change latencyhigh to 500 ms / 5 min, drop the comment
my ($st, $r) = $A->can('alertdefs_save')->({ name => 'latencyhigh', rule => { kind => 'latency', ms => 500, minutes => 5 }, comment => '', edgetrigger => 1, priority => 10 });
ok($st == 200 && !${ $r->{created} }, 'edit ok');
my $t = slurp("$d/Alerts");
ok($t =~ /^pattern = CheckLatency\(l=>500,x=>30\)$/m, 'edited pattern written');
ok($t !~ /Round-trip latency above 300/, 'comment removed');
ok($t =~ /# --- latency ---/, 'section comment (belongs to next block) preserved');
ok($t =~ /\+latencyshift/, 'neighbour intact');
ok(-f "$d/Alerts.bak", 'backup made');

# create
($st, $r) = $A->can('alertdefs_save')->({ name => 'slowlink', create => 1, rule => { kind => 'loss', pct => 5, minutes => 2 }, comment => 'my rule', edgetrigger => 1 });
ok($st == 200 && ${ $r->{created} }, 'create ok');
$t = slurp("$d/Alerts");
ok($t =~ /\+slowlink\ntype = matcher\npattern = ConsecutiveLoss\(pctlossraise=>5,stepsraise=>12,pctlossclear=>3,stepsclear=>24\)\ncomment = my rule\nedgetrigger = yes\n$/, 'appended block');
eval { $A->can('alertdefs_save')->({ name => 'slowlink', create => 1, rule => { kind => 'down', pct => 90, minutes => 1 } }) };
ok(ref $@ && $@->{status} == 422, 'duplicate create refused');
eval { $A->can('alertdefs_save')->({ name => 'nope', rule => { kind => 'down', pct => 90, minutes => 1 } }) };
ok(ref $@ && $@->{status} == 404, 'edit unknown refused');
eval { $A->can('alertdefs_save')->({ name => 'bad name', create => 1, rule => { kind => 'down', pct => 90, minutes => 1 } }) };
ok(ref $@ && $@->{status} == 422, 'bad name refused');
eval { $A->can('alertdefs_save')->({ name => 'x1', create => 1, rule => { kind => 'loss', pct => 500, minutes => 1 } }) };
ok(ref $@ && $@->{status} == 422, 'bad rule refused');

# delete: refused while used, ok when free
($st, $r) = $A->can('alertdefs_delete')->({ name => 'hostdown' });
ok($st == 422 && @{ $r->{usedBy} } == 2, 'delete in-use refused');
($st, $r) = $A->can('alertdefs_delete')->({ name => 'majorloss' });
ok($st == 200, 'delete free ok');
$t = slurp("$d/Alerts");
ok($t !~ /majorloss/ && $t =~ /\+lossdetect/ && $t =~ /\+hostdown/, 'block removed, others intact');
ok($t =~ /# --- packet loss ---/, 'section comment kept');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
