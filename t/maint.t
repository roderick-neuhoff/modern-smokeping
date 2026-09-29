use strict; use warnings;
use FindBin (); use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
use POSIX (); use JSON::PP ();
my $d = tempdir(CLEANUP => 1);
mkdir "$d/log";
$ENV{SMOKEPING_CONFIG_DIR} = $d;
$ENV{SMOKEPING_LOG} = "$d/log/smokeping.log";
require SmokepingModern::Maintenance;
my $M = 'SmokepingModern::Maintenance';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
sub dies { my ($code, $re, $m) = @_; eval { $code->() }; ok(ref $@ eq 'HASH' && $@->{status} == 422 && $@->{error} =~ $re, "$m -> " . (ref $@ ? $@->{error} : "no die $@")) }
sub at { my ($y,$mo,$d,$h,$mi) = @_; POSIX::mktime(0,$mi,$h,$d,$mo-1,$y-1900) }
sub ts { my $t = shift; scalar POSIX::strftime('%a %b %e %H:%M:%S %Y', localtime $t) }
sub wr { open my $f, '>>', "$d/log/smokeping.log" or die; print $f @_; close $f }

# --- normalize --------------------------------------------------------------
my $now = at(2026, 9, 18, 12, 0);
my $w = $M->can('normalize')->({ title => "  Router\nswap ", paths => ['/WAN/', '/Sites/Google', '/WAN'], mode => 'once', start => $now, end => $now + 7200 }, $now);
ok($w->{title} eq 'Router swap', 'title cleaned');
ok(join(',', @{ $w->{paths} }) eq '/Sites/Google,/WAN', 'paths trimmed + de-duplicated');
ok($w->{mode} eq 'once' && $w->{end} - $w->{start} == 7200, 'once window');
dies(sub { $M->can('normalize')->({ mode => 'once', start => $now, end => $now }) }, qr/after start/, 'end must follow start');
dies(sub { $M->can('normalize')->({ mode => 'once', start => $now, end => $now + 70 * 86400 }) }, qr/60 days/, 'cap 60 days');
dies(sub { $M->can('normalize')->({ mode => 'once', start => 'x', end => 1 }) }, qr/start must be a number/, 'non numeric start');
dies(sub { $M->can('normalize')->({ mode => 'once', start => 1, end => 9, paths => ['WAN'] }) }, qr/bad scope/, 'bad scope');
dies(sub { $M->can('normalize')->({ mode => 'weekly', days => [], time => '03:00', durationMin => 60 }) }, qr/weekday/, 'weekly needs a day');
dies(sub { $M->can('normalize')->({ mode => 'weekly', days => [1], time => '25:00', durationMin => 60 }) }, qr/time must/, 'bad time');
dies(sub { $M->can('normalize')->({ mode => 'weekly', days => [1], time => '03:00', durationMin => 0 }) }, qr/duration/, 'bad duration');
dies(sub { $M->can('normalize')->({ mode => 'nope' }) }, qr/mode must/, 'bad mode');
my $wk = $M->can('normalize')->({ mode => 'weekly', days => [0, 6, 6], time => '3:30', durationMin => 120, enabled => 1 });
ok($wk->{time} eq '03:30' && join(',', @{ $wk->{days} }) eq '0,6', 'weekly normalised');

# --- once + scope -----------------------------------------------------------------
my @wins = ( { %$w, id => 'a' } );
ok(!$M->can('covers')->('/WAN/Quad9', $now - 1, \@wins), 'before window: not covered');
ok($M->can('covers')->('/WAN/Quad9', $now + 60, \@wins), 'group scope covers a child target');
ok($M->can('covers')->('/Sites/Google', $now + 60, \@wins), 'target scope covers the target');
ok(!$M->can('covers')->('/Sites/Cloudflare', $now + 60, \@wins), 'other target not covered');
ok(!$M->can('covers')->('/WANDER/x', $now + 60, \@wins), 'prefix match respects path boundaries');
ok(!$M->can('covers')->('/WAN/Quad9', $now + 7200, \@wins), 'end is exclusive');
my $all = [ { id => 'z', title => 'All', mode => 'once', start => $now, end => $now + 100, paths => [] } ];
ok($M->can('covers')->('/anything/at/all', $now + 5, $all), 'empty scope = everything');
my $off = [ { id => 'o', title => 'Off', mode => 'once', start => $now, end => $now + 100, paths => [], enabled => JSON::PP::false() } ];
ok(!$M->can('covers')->('/x', $now + 5, $off), 'disabled window ignored');

# --- weekly (2026-09-18 is a Friday = 5; use Sat 03:30 for 2 h and an overnight one) ----------
my $sat = at(2026, 9, 19, 3, 30);
my @wk = ({ id => 'w', title => 'Backups', mode => 'weekly', days => [6], time => '03:30', durationMin => 120, paths => [] });
ok($M->can('covers')->('/x', $sat + 60, \@wk), 'weekly: inside Saturday window');
ok(!$M->can('covers')->('/x', $sat - 60, \@wk), 'weekly: just before');
ok(!$M->can('covers')->('/x', $sat + 7200, \@wk), 'weekly: just after');
ok(!$M->can('covers')->('/x', $sat + 86400 + 60, \@wk), 'weekly: Sunday same time is not covered');
ok($M->can('covers')->('/x', $sat + 7 * 86400 + 60, \@wk), 'weekly: next Saturday is covered');
my @night = ({ id => 'n', title => 'Night', mode => 'weekly', days => [5], time => '23:00', durationMin => 240, paths => [] });
ok($M->can('covers')->('/x', at(2026, 9, 18, 23, 30), \@night), 'overnight: Friday 23:30 covered');
ok($M->can('covers')->('/x', at(2026, 9, 19, 2, 30), \@night), 'overnight: spills into Saturday 02:30');
ok(!$M->can('covers')->('/x', at(2026, 9, 19, 3, 30), \@night), 'overnight: over by Saturday 03:30');
my @iv = $M->can('intervals')->('/x', at(2026, 9, 1, 0, 0), at(2026, 9, 30, 0, 0), \@wk);
ok(@iv == 4, 'weekly: 4 Saturdays in September 2026 window (got ' . scalar(@iv) . ')');

# --- state / active ------------------------------------------------------------------------
my $st = $M->can('state_of')->($wins[0], $now + 60);
ok($st->{status} eq 'active' && $st->{until} == $now + 7200, 'state active with until');
$st = $M->can('state_of')->($wins[0], $now - 3600);
ok($st->{status} eq 'upcoming' && $st->{next} == $now, 'state upcoming');
$st = $M->can('state_of')->($wins[0], $now + 9000);
ok($st->{status} eq 'ended', 'state ended');
$st = $M->can('state_of')->($wk[0], $sat + 86400);
ok($st->{status} eq 'upcoming' && $st->{next} == $sat + 7 * 86400, 'weekly upcoming = next Saturday');
my @act = $M->can('active')->($now + 60, \@wins);
ok(@act == 1 && $act[0]{title} eq 'Router swap' && $act[0]{until} == $now + 7200, 'active list');

# --- persistence + gate ---------------------------------------------------------------------
$M->can('save')->([ { %$w, id => 'a' } ]);
ok(@{ $M->can('load')->() } == 1, 'save/load round trip');
my $t0 = time;
# raise inside the window
$M->can('save')->([ { id => 'live', title => 'Swap', mode => 'once', start => $t0 - 600, end => $t0 + 3600, paths => ['/Sites'] } ]);
ok(($M->can('suppress_alert')->('hostdown', 'raised', 'Sites.Google') // '') eq 'Swap', 'raise on covered target is suppressed');
ok(!defined $M->can('suppress_alert')->('hostdown', 'raised', 'WAN.Quad9'), 'raise elsewhere is not');
ok(($M->can('suppress_alert')->('hostdown', 'raised', 'Sites.Google [from slave1]') // '') eq 'Swap', 'slave suffix ignored');
# a recovery of an outage that began BEFORE the window is still announced
wr(ts($t0 - 1200) . " - Alert hostdown was raised for Sites.Google loss: 100%\n");
wr(ts($t0 - 5)    . " - Alert hostdown was cleared for Sites.Google loss: 0%\n");
ok(!defined $M->can('suppress_alert')->('hostdown', 'cleared', 'Sites.Google'), 'recovery of a pre-window outage is announced');
# ... but one that began inside the window is not
wr(ts($t0 - 300) . " - Alert lossdetect was raised for Sites.Google loss: 50%\n");
wr(ts($t0 - 2)   . " - Alert lossdetect was cleared for Sites.Google loss: 0%\n");
ok(($M->can('suppress_alert')->('lossdetect', 'cleared', 'Sites.Google') // '') eq 'Swap', 'recovery of an in-window outage is suppressed');
ok(($M->can('suppress_message')->('[SmokeAlert] hostdown was raised on Sites.Google') // '') eq 'Swap', 'mail subject: raised suppressed');
ok(!defined $M->can('suppress_message')->('[SmokeAlert] TEST hostdown was raised on Sites.Google'), 'test mail never suppressed');
ok(!defined $M->can('suppress_message')->('Something else entirely'), 'unrelated mail passes');
ok(!defined $M->can('suppress_message')->('[SmokeAlert] hostdown was raised on WAN.Quad9'), 'mail for other target passes');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
