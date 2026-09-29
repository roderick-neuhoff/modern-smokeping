package SmokepingModern::Delivery;

# Did the notifications actually go out?
#
# Every sender (bin/notify per webhook channel, bin/graph-send and bin/sendmail
# for e-mail, bin/worker for its own "polling stopped" notices) records the
# outcome here. The UI turns a failing channel into a banner, so a broken
# webhook URL or an expired mail secret no longer fails silently.
#
# /config/modern-delivery.json:
#   { "channels": { "discord": { lastAttempt, lastOk, lastFail, lastError, fails, sent, test } } }
# `fails` counts consecutive failures; any success resets it.
#
# Plain Perl, no SmokePing dependency.

use strict;
use warnings;

use Fcntl qw(:flock SEEK_SET);
use JSON::PP ();
use SmokepingModern::Events ();

my $J = JSON::PP->new->utf8->canonical(1);

sub file { $ENV{SPM_DELIVERY_FILE} || SmokepingModern::Events::config_dir() . '/modern-delivery.json' }

sub _decode {
    my $raw = shift;
    my $d = eval { $J->decode($raw) } if defined $raw && length $raw;
    $d = {} unless ref $d eq 'HASH';
    $d->{channels} = {} unless ref $d->{channels} eq 'HASH';
    return $d;
}

sub load {
    open my $fh, '<', file() or return { channels => {} };
    local $/;
    my $raw = <$fh>;
    close $fh;
    return _decode($raw);
}

# record(channel, ok, message, %o)   o: test => 1, at => epoch
sub record {
    my ($ch, $ok, $msg, %o) = @_;
    return unless defined $ch && length $ch;
    my $now = $o{at} // time;
    open my $fh, '+>>', file() or return;
    flock $fh, LOCK_EX;
    seek $fh, 0, SEEK_SET;
    my $raw = do { local $/; <$fh> };
    my $d = _decode($raw);
    my $c = $d->{channels}{$ch} ||= { fails => 0, sent => 0 };
    $c->{lastAttempt} = $now;
    $c->{test} = $o{test} ? JSON::PP::true : JSON::PP::false;
    if ($ok) {
        $c->{lastOk} = $now;
        $c->{fails} = 0;
        $c->{sent}++;
        delete $c->{lastError};
    } else {
        $c->{lastFail} = $now;
        $c->{fails}++;
        $c->{lastError} = substr((defined $msg ? $msg : 'failed'), 0, 300);
    }
    seek $fh, 0, SEEK_SET;
    truncate $fh, 0;
    print $fh $J->encode($d);
    close $fh;
    return 1;
}

# channels whose most recent attempt failed
sub failing {
    my $d = shift || load();
    my @out;
    for my $ch (sort keys %{ $d->{channels} }) {
        my $c = $d->{channels}{$ch};
        next unless ($c->{fails} // 0) > 0;
        push @out, { channel => $ch, fails => $c->{fails} + 0, lastFail => $c->{lastFail}, lastOk => $c->{lastOk},
                     lastError => $c->{lastError} };
    }
    return \@out;
}

1;
