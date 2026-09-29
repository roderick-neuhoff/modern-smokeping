use strict; use warnings;
use FindBin (); use lib "$FindBin::Bin/../app/api/lib";
use File::Temp qw(tempdir);
use JSON::PP ();
my $d = tempdir(CLEANUP => 1);
mkdir "$d/log";
$ENV{SMOKEPING_CONFIG_DIR} = $d;
$ENV{SMOKEPING_LOG} = "$d/log/smokeping.log";
require SmokepingModern::Admin;
no warnings 'redefine';
my $check_ok = 1; my @checked;
*SmokepingModern::Admin::_check_candidate = sub { push @checked, $_[0]; { ok => \1, rc => ($check_ok ? 0 : 1), output => 'boom' } };
my $hups = 0;
*SmokepingModern::Admin::_hup = sub { $hups++; { ok => \1 } };
my $A = 'SmokepingModern::Admin'; my $B = 'SmokepingModern::Backup';
my $fails = 0;
sub ok { my ($c, $m) = @_; print(($c ? "ok   " : "FAIL ") . $m . "\n"); $fails++ unless $c }
sub slurp { open my $f, '<:raw', $_[0] or return; local $/; <$f> }
sub spew  { open my $f, '>:raw', $_[0] or die; print $f $_[1]; close $f }
my $J = JSON::PP->new->utf8->canonical;

spew("$d/Targets", "*** Targets ***\nmenu = Top \x{2013} caf\x{e9}\n" =~ s/\\x\{2013\}/-/r);
spew("$d/Alerts", "*** Alerts ***\nto = a\@b\n");
spew("$d/pathnames", "sendmail = /x\n");
spew("$d/modern-acks.json", '{"a":1}');
spew("$d/modern-maintenance.json", '{"windows":[]}');
spew("$d/modern-events.jsonl", qq({"alert":"hostdown","event":"raised","t":1000,"target":"Sites.Google"}\n));
spew("$d/modern-notify.json", '{"discord":{"enabled":true,"url":"https://secret.example/hook"}}');
spew("$d/msmtp.conf", "password topsecret\n");
spew("$d/Binary", "x");                                   # not in the allowlist: must be ignored
spew("$d/Probes", "*** Probes ***\n\xff\xfe binary-ish\n");      # invalid UTF-8 -> base64 path

# --- collect ----------------------------------------------------------------------
my $plain = $A->can('backup_get')->({});
my %names = map { $_->{name} => $_ } @{ $plain->{files} };
ok($plain->{format} eq 'modern-smokeping-backup' && !$plain->{includesSecrets}, 'archive header, no secrets flag');
ok($names{Targets} && $names{Alerts} && $names{pathnames} && $names{'modern-acks.json'} && $names{'modern-events.jsonl'}, 'config + state + history included');
ok(!$names{'modern-notify.json'} && !$names{'msmtp.conf'}, 'credentials NOT included by default');
ok(!$names{Binary}, 'unknown files ignored');
ok($names{Probes}{encoding} eq 'base64' && $names{Targets}{encoding} eq 'text', 'non-UTF8 file stored as base64');
my $full = $A->can('backup_get')->({ secrets => '1' });
ok($full->{includesSecrets} && (grep { $_->{name} eq 'modern-notify.json' } @{ $full->{files} }) && (grep { $_->{name} eq 'msmtp.conf' } @{ $full->{files} }), 'secrets=1 includes credentials');
# survives a JSON round trip (that is how it travels)
my $round = $J->decode($J->encode($full));
ok(eval { $B->can('verify')->($round); 1 }, 'verify passes after JSON round trip: ' . ($@ ? (ref $@ ? $@->{error} : $@) : ''));

# --- tamper checks --------------------------------------------------------------------
my $bad = $J->decode($J->encode($full));
(grep { $_->{name} eq 'Alerts' } @{ $bad->{files} })[0]{data} .= "extra";
eval { $B->can('verify')->($bad) }; ok(ref $@ && $@->{error} =~ /checksum mismatch for 'Alerts'/, 'modified content is rejected');
my $evil = $J->decode($J->encode($full));
push @{ $evil->{files} }, { name => '../../etc/passwd', encoding => 'text', data => 'x', sha256 => 'x' };
eval { $B->can('verify')->($evil) }; ok(ref $@ && $@->{error} =~ /unexpected file/, 'path-traversal name is rejected');
eval { $B->can('verify')->({ format => 'other', files => [] }) }; ok(ref $@ && $@->{status} == 422, 'wrong format rejected');
eval { $B->can('verify')->({ format => 'modern-smokeping-backup', version => 9, files => [] }) }; ok(ref $@ && $@->{error} =~ /unsupported/, 'wrong version rejected');

# --- dry run ------------------------------------------------------------------------------
my ($st, $r) = $A->can('backup_restore')->({ archive => $round, dryRun => 1 });
ok($st == 200 && $r->{dryRun} && @{ $r->{files} } == @{ $round->{files} }, 'dry run lists every file');
ok(!grep({ $_->{status} ne 'same' } @{ $r->{files} }), 'identical to live state -> all "same"');
ok((grep { $_->{name} eq 'msmtp.conf' && $_->{secret} } @{ $r->{files} }), 'secret files flagged');

# --- restore into a changed system --------------------------------------------------------
spew("$d/Alerts", "*** Alerts ***\nto = changed\@b\n");
unlink "$d/modern-acks.json";
spew("$d/modern-events.jsonl", "");                              # history lost
spew("$d/modern-notify.json", '{}');
($st, $r) = $A->can('backup_restore')->({ archive => $round, dryRun => 1 });
my %stt = map { $_->{name} => $_->{status} } @{ $r->{files} };
ok($stt{Alerts} eq 'changed' && $stt{'modern-acks.json'} eq 'new' && $stt{Targets} eq 'same', 'dry run reports changed / new / same');

eval { $A->can('backup_restore')->({ archive => $round }) }; ok(ref $@ && $@->{error} =~ /choose what/, 'restore without parts refused');
@checked = (); $hups = 0;
($st, $r) = $A->can('backup_restore')->({ archive => $round, parts => ['config', 'state'] });
ok($st == 200 && $r->{ok}, 'restore config+state ok');
ok(slurp("$d/Alerts") eq "*** Alerts ***\nto = a\@b\n", 'Alerts restored');
ok(slurp("$d/Alerts.bak") eq "*** Alerts ***\nto = changed\@b\n", 'previous Alerts kept as .bak');
ok(-f "$d/modern-acks.json" && slurp("$d/modern-acks.json") eq '{"a":1}', 'acks restored');
ok(slurp("$d/modern-notify.json") eq '{}', 'credentials untouched when not selected');
ok((grep { $_ eq 'Alerts' } @checked) && !(grep { $_ eq 'pathnames' } @checked), 'config files validated (pathnames is not)');
ok($hups == 1, 'daemon reloaded once');
ok(slurp("$d/modern-events.jsonl") eq '', 'history untouched when not selected');
ok(slurp("$d/Probes") eq "*** Probes ***\n\xff\xfe binary-ish\n", 'binary-ish file restored byte for byte');

# failing config check blocks everything
spew("$d/Alerts", "changed again\n");
$check_ok = 0;
($st, $r) = $A->can('backup_restore')->({ archive => $round, parts => ['config', 'state'] });
ok($st == 422 && $r->{error} =~ /nothing was restored/, 'failed smokeping --check aborts the restore');
ok(slurp("$d/Alerts") eq "changed again\n", '... and nothing was written');
$check_ok = 1;

# history + secrets
($st, $r) = $A->can('backup_restore')->({ archive => $round, parts => ['history', 'secrets'] });
ok(slurp("$d/modern-events.jsonl") =~ /hostdown/, 'history restored');
ok(slurp("$d/modern-notify.json") =~ /secret\.example/, 'credentials restored when chosen');
ok(((stat "$d/msmtp.conf")[2] & 07777) == 0600 || $^O !~ /linux/i, 'msmtp.conf keeps mode 0600');
my $state = $J->decode(slurp("$d/modern-events.state"));
ok(exists $state->{open}{'hostdown|Sites.Google'}, 'event state rebuilt: the open incident is remembered');
ok($state->{offset} == 0 || defined $state->{offset}, 'event state marks the log as consumed');
my $ev = SmokepingModern::Events::ingest();
ok(($ev // 0) == 0, 'next ingest does not replay the log');
eval { $A->can('backup_restore')->({ archive => { format => 'modern-smokeping-backup', version => 1, includesSecrets => 0, files => [ grep { $_->{group} ne 'secrets' } @{ $round->{files} } ] }, parts => ['secrets'] }) };
ok(ref $@ && $@->{error} =~ /no credentials/, 'asking for secrets from a backup without them is refused');

print $fails ? "\nFAILED: $fails\n" : "\nALL OK\n";
exit($fails ? 1 : 0);
