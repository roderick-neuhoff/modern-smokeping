# Delivery.pm + bin/delivery-record: send outcomes per channel.
use strict; use warnings;
use FindBin ();
use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
my $d = tempdir(CLEANUP => 1);
$ENV{SMOKEPING_CONFIG_DIR} = $d;
require SmokepingModern::Delivery;
my $D = 'SmokepingModern::Delivery';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }

ok(@{ $D->can('failing')->() } == 0, 'nothing recorded -> nothing failing');
$D->can('record')->('webhook', 0, 'HTTP 000 (curl rc=7)', at => 100);
$D->can('record')->('webhook', 0, 'HTTP 000 (curl rc=7)', at => 200);
$D->can('record')->('discord', 1, 'HTTP 204', at => 150);
my $f = $D->can('failing')->();
ok(@$f == 1 && $f->[0]{channel} eq 'webhook' && $f->[0]{fails} == 2 && $f->[0]{lastFail} == 200, 'consecutive failures counted per channel');
my $c = $D->can('load')->()->{channels};
ok($c->{discord}{sent} == 1 && $c->{discord}{lastOk} == 150 && !$c->{discord}{fails}, 'success recorded');
$D->can('record')->('webhook', 1, 'HTTP 200', at => 300);
$c = $D->can('load')->()->{channels};
ok($c->{webhook}{fails} == 0 && !exists $c->{webhook}{lastError} && $c->{webhook}{lastFail} == 200, 'success resets the streak, keeps lastFail');
$D->can('record')->('mail', 0, 'x' x 1000, test => 1);
ok(length($D->can('load')->()->{channels}{mail}{lastError}) == 300 && $D->can('load')->()->{channels}{mail}{test}, 'error text capped; test flag kept');
open my $fh, '>', "$d/modern-delivery.json"; print $fh "garbage"; close $fh;
ok(eval { $D->can('record')->('x', 1, 'ok'); 1 } && $D->can('load')->()->{channels}{x}{sent} == 1, 'corrupt file is replaced, not fatal');

# the shell senders' helper
my $rec = "$FindBin::Bin/../app/bin/delivery-record";
open my $p, '|-', $^X, $rec, 'mail', '75' or die; print $p "Subject: [SmokeAlert] hostdown was raised on A.B\n\nbody\n"; close $p;
my $m = $D->can('load')->()->{channels}{mail};
ok($m->{fails} == 1 && $m->{lastError} =~ /exit 75 - temporary failure/ && !$m->{test}, 'delivery-record: msmtp exit code explained');
open $p, '|-', $^X, $rec, 'mail', '0' or die; print $p "Subject: TEST mail\n\nbody\n"; close $p;
$m = $D->can('load')->()->{channels}{mail};
ok($m->{fails} == 0 && $m->{test}, 'delivery-record: success + test detected from the subject');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
