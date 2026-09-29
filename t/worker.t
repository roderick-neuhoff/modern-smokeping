# bin/worker: incident ingest + "polling stopped" / "back" notices.
use strict; use warnings;
use FindBin ();
use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
use JSON::PP ();
my $d = tempdir(CLEANUP => 1);
mkdir "$d/$_" for qw(log data data/WAN);
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
sub spew { open my $f, '>', $_[0] or die "$_[0]: $!"; print $f $_[1]; close $f }
sub slurp { open my $f, '<', $_[0] or return ''; local $/; <$f> }
my $unix = $^O ne 'MSWin32';

# fake notifier + sendmail that just record how they were called
my $calls = "$d/calls.txt";
for my $name (qw(fakenotify fakesendmail)) {
    spew("$d/$name", "#!$^X\nopen my \$o, '>>', '$calls'; my \$in = ''; \$in = join '', <STDIN> if '$name' eq 'fakesendmail';\n"
        . "print \$o '$name|' . join('|', \@ARGV) . '|MSG=' . (\$ENV{SPM_MESSAGE} // '') . '|IN=' . \$in . \"\\n---\\n\";\n");
    chmod 0755, "$d/$name";
}
spew("$d/Database", "*** Database ***\nstep = 10\n");
spew("$d/Alerts", "*** Alerts ***\nto = |$d/fakenotify, ops\@example.com\nfrom = sp\@example.com\n\n+hostdown\ntype = loss\npattern = >90%\n");
spew("$d/pathnames", "sendmail = $d/fakesendmail\n");
spew("$d/log/smokeping.log", scalar(localtime(time - 100)) . " - Alert hostdown was raised for WAN.Quad9 loss: 100%\n");
for (qw(WAN/Quad9 WAN/Google)) { spew("$d/data/$_.rrd", 'x') }

local $ENV{SMOKEPING_CONFIG_DIR} = $d;
local $ENV{SMOKEPING_LOG} = "$d/log/smokeping.log";
local $ENV{SMOKEPING_DATA_DIR} = "$d/data";
my $worker = "$FindBin::Bin/../app/bin/worker";
my $run = sub { system($^X, $worker) == 0 };
my $state = sub { JSON::PP->new->decode(slurp("$d/modern-worker.json") || '{}') };

# fresh rrds: nothing to announce, the log is ingested
ok($run->(), 'worker runs');
my $s = $state->();
ok($s->{lastRun} && $s->{rrdCount} == 2 && !$s->{pollingStopped}, 'fresh data: no polling alarm, 2 rrds seen');
ok($s->{eventsAdded} == 1 && slurp("$d/modern-events.jsonl") =~ /WAN\.Quad9/, 'incident history ingested without any browser');
ok(!-e $calls, 'nothing sent');

# rrds stop moving -> one "polling stopped" notice
my $old = time - 3600;
utime $old, $old, "$d/data/WAN/Quad9.rrd", "$d/data/WAN/Google.rrd";
$run->();
$s = $state->();
ok($s->{pollingStopped} && $s->{pollingStopped} == $old, 'stale rrds -> polling marked stopped');
SKIP: {
    last SKIP unless $unix;
    my $c = slurp($calls);
    ok($c =~ /^fakenotify\|polling\|SmokePing\|\|\|\|1\|MSG=SmokePing has not recorded a measurement since/m, 'webhook notifier called with a RAISED polling notice');
    ok($c =~ /^fakesendmail\|-f\|sp\@example\.com\|ops\@example\.com\|/m && $c =~ /Subject: \[SmokeAlert\] polling was raised on SmokePing/, 'e-mail sent to the alert recipients');
}
my $n1 = () = slurp($calls) =~ /---/g;
$run->();
my $n2 = () = slurp($calls) =~ /---/g;
ok($n1 == $n2, 'still stopped: not announced again');

# measurements resume -> one recovery notice
utime time, time, "$d/data/WAN/Quad9.rrd";
$run->();
$s = $state->();
ok(!$s->{pollingStopped}, 'fresh rrd again -> recovered');
SKIP: {
    last SKIP unless $unix;
    my $c = slurp($calls);
    ok($c =~ /^fakenotify\|polling\|SmokePing\|\|\|\|0\|MSG=SmokePing is recording measurements again - back after 1h/m, 'recovery notice with outage length');
    ok($c =~ /polling was cleared on SmokePing/, 'recovery e-mail');
}
ok(slurp("$d/log/notify.log") =~ /polling RAISED/ && slurp("$d/log/notify.log") =~ /polling CLEARED/, 'both notices logged');

# only one stale target: that is the target's problem, not SmokePing's
utime $old, $old, "$d/data/WAN/Google.rrd";
$run->();
ok(!$state->()->{pollingStopped}, 'a single stale rrd does not trigger the polling alarm');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
