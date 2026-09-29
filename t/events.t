use strict; use warnings;
use FindBin (); use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
use POSIX ();

my $d = tempdir(CLEANUP => 1);
mkdir "$d/log";
$ENV{SMOKEPING_CONFIG_DIR} = $d;
$ENV{SMOKEPING_LOG} = "$d/log/smokeping.log";
require SmokepingModern::Events;
my $E = 'SmokepingModern::Events';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }

sub ts { my ($h,$m,$s) = @_; my @t = localtime(POSIX::mktime($s,$m,$h,7,8,126)); scalar POSIX::strftime('%a %b %e %H:%M:%S %Y', @t) }
sub wr { open my $f, '>>', "$d/log/smokeping.log" or die; print $f @_; close $f }

# --- parse ---------------------------------------------------------------
my $p = $E->can('parse_line')->(ts(23,1,44) . " - Alert majorloss was raised for Sites.Unreachable loss: S, 100%(20/20)  rtt: S, U");
ok($p && $p->{what} eq 'raised' && $p->{alert} eq 'majorloss' && $p->{target} eq 'Sites.Unreachable', 'parse raised line');
ok(!defined $E->can('parse_line')->("garbage line"), 'garbage ignored');
ok($E->can('target_to_path')->('Sites.Google') eq '/Sites/Google', 'dotted -> path');
ok($E->can('target_to_path')->('A.B [from slave1]') eq '/A/B', 'slave suffix stripped');

# --- ingest edge-triggered ---------------------------------------------------
wr(ts(10,0,0)  . " - Smokeping version 2.009000 successfully launched.\n");
wr(ts(10,5,0)  . " - Alert hostdown was raised for Sites.Google loss: 100% rtt: U prevmatch: 0 comment: x\n");
wr(ts(10,5,0)  . " - Alert hostdown was raised for Sites.Google loss: 100% rtt: U prevmatch: 0 comment: x\n");   # dup
wr(ts(10,9,12) . " - Alert hostdown was cleared for Sites.Google loss: 0% rtt: 15ms prevmatch: 1 comment: x\n");
wr(ts(11,0,0)  . " - Alert lossdetect was raised for WAN.Quad9 loss: 30% rtt: 15ms prevmatch: 0 comment: y\n");
my $n = $E->can('ingest')->();
ok($n == 3, "ingest added 3 events (got $n)");
ok($E->can('ingest')->() == 0, 're-ingest is a no-op');

my $ev  = $E->can('read_store')->();
ok(@$ev == 3, 'store has 3 lines');
my $inc = $E->can('incidents')->($ev, POSIX::mktime(0,0,12,7,8,126));
ok(@$inc == 2, 'two incidents');
my ($g) = grep { $_->{target} eq 'Sites.Google' } @$inc;
ok($g && !$g->{open} && $g->{durationSec} == 4*60+12, "closed incident duration 4m12s (got " . ($g ? $g->{durationSec} : 'undef') . ")");
my ($q) = grep { $_->{target} eq 'WAN.Quad9' } @$inc;
ok($q && $q->{open} && $q->{durationSec} == 3600, 'open incident: ongoing 1h');

# --- duration helper for scripts ----------------------------------------------
my $dur = $E->can('outage_duration')->('hostdown', 'Sites.Google');
ok(defined $dur && $dur == 252, "outage_duration = 252s (got " . ($dur // 'undef') . ")");
ok(!defined $E->can('outage_duration')->('nope', 'x'), 'unknown alert -> undef');
ok($E->can('fmt_duration')->(252) eq '4m12s', 'fmt 4m12s');
ok($E->can('fmt_duration')->(45) eq '45s', 'fmt 45s');
ok($E->can('fmt_duration')->(3900) eq '1h05m', 'fmt 1h05m');
ok($E->can('fmt_duration')->(90000) eq '1d 1h', 'fmt 1d 1h');

# --- level-triggered: "is active" every cycle, never cleared ----------------------
wr(ts(12,0,0)  . " - Alert lvl is active for LAN.Gw loss: 100% rtt: U\n");
wr(ts(12,0,10) . " - Alert lvl is active for LAN.Gw loss: 100% rtt: U\n");
wr(ts(12,0,20) . " - Alert lvl is active for LAN.Gw loss: 100% rtt: U\n");
$n = $E->can('ingest')->();
ok($n == 2, "level alert (stale timestamps): raised + inferred cleared in one pass (got $n)");
# the run is long past (year 2026 fixed, real time is later) -> next ingest closes it
$n = $E->can('ingest')->();
ok($n == 0, "no duplicate closure on re-ingest (got $n)");
$ev = $E->can('read_store')->();
my @lvl = grep { $_->{target} eq 'LAN.Gw' } @$ev;
ok(@lvl == 2 && $lvl[1]{event} eq 'cleared' && $lvl[1]{level}, 'level alert closed by grace period');
my $inc2 = $E->can('incidents')->($ev, time);
my ($l) = grep { $_->{target} eq 'LAN.Gw' } @$inc2;
ok($l && !$l->{open} && $l->{durationSec} == 20, "level incident duration = 20s (got " . ($l ? $l->{durationSec} : 'undef') . ")");

# --- truncation / rotation of the log ---------------------------------------------
open my $t, '>', "$d/log/smokeping.log" or die; close $t;     # truncate
wr(ts(13,0,0) . " - Alert hostdown was raised for Sites.Google loss: 100% rtt: U\n");
$n = $E->can('ingest')->();
ok($n == 1, "after truncation the new line is still picked up (got $n)");

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
