package SmokepingModern::Backup;

# One-file backup / restore of everything that is configuration or state.
#
#   config   Targets Alerts Probes Database General Presentation Slaves pathnames
#   state    acknowledgements, maintenance windows, uptime goals
#   history  the persistent incident store
#   secrets  mail + webhook credentials (only when asked for - see collect)
#
# NOT included: the RRD data under /data (large; back that volume up as files),
# the login hash, logs. The archive is a single JSON document:
#   { format, version, created, host, appVersion, includesSecrets,
#     files: [ { name, group, bytes, sha256, encoding: "text"|"base64", data } ] }
# Every file carries a SHA-256, checked on restore.
#
# Plain Perl (unit-testable); Admin.pm adds authentication and config validation.

use strict;
use warnings;

use Digest::SHA ();
use Encode ();
use MIME::Base64 ();
use POSIX ();
use SmokepingModern::Events ();

our $FORMAT  = 'modern-smokeping-backup';
our $VERSION_ = 1;

our %GROUP_FILES = (
    config  => [qw(Targets Alerts Probes Database General Presentation Slaves pathnames)],
    state   => [qw(modern-acks.json modern-maintenance.json modern-goals.json)],
    history => [qw(modern-events.jsonl)],
    secrets => [qw(modern-notify.json modern-oauth.json msmtp.conf ssmtp.conf)],
);
our @GROUP_ORDER = qw(config state history secrets);
my %GROUP_OF = map { my $g = $_; map { $_ => $g } @{ $GROUP_FILES{$g} } } keys %GROUP_FILES;

# private files get tighter permissions when restored
my %MODE = ('msmtp.conf' => 0600, 'modern-oauth.json' => 0600, 'modern-notify.json' => 0640, 'ssmtp.conf' => 0640);

sub group_of { $GROUP_OF{ $_[0] } }

sub _slurp_bytes {
    my $f = shift;
    open my $fh, '<:raw', $f or return undef;
    local $/;
    my $b = <$fh>;
    close $fh;
    return $b;
}

sub _pack_file {
    my ($name, $bytes) = @_;
    my %f = ( name => $name, group => $GROUP_OF{$name}, bytes => length $bytes, sha256 => Digest::SHA::sha256_hex($bytes) );
    my $copy = $bytes;
    if (eval { Encode::decode('UTF-8', $copy, Encode::FB_CROAK | Encode::LEAVE_SRC); 1 }) {
        $f{encoding} = 'text';
        $f{data} = Encode::decode('UTF-8', $bytes);
    } else {
        $f{encoding} = 'base64';
        $f{data} = MIME::Base64::encode_base64($bytes, '');
    }
    return \%f;
}

# raw bytes of a packed file
sub file_bytes {
    my $f = shift;
    return $f->{encoding} eq 'base64' ? MIME::Base64::decode_base64($f->{data}) : Encode::encode('UTF-8', $f->{data});
}

# -> archive hashref. %o: secrets => 1 to include credentials
sub collect {
    my ($dir, %o) = @_;
    my @files;
    for my $g (@GROUP_ORDER) {
        next if $g eq 'secrets' && !$o{secrets};
        for my $name (@{ $GROUP_FILES{$g} }) {
            my $bytes = _slurp_bytes("$dir/$name");
            push @files, _pack_file($name, $bytes) if defined $bytes && length $bytes;
        }
    }
    return {
        format => $FORMAT, version => $VERSION_ + 0, created => time,
        host => (POSIX::uname())[1], appVersion => ($o{appVersion} // ''),
        includesSecrets => ($o{secrets} ? 1 : 0) + 0,
        files => \@files,
    };
}

# structural + checksum check; dies { status => 422 }. Returns the file list.
sub verify {
    my $a = shift;
    die { status => 422, error => 'that is not a modern-smokeping backup file' }
        unless ref $a eq 'HASH' && ($a->{format} // '') eq $FORMAT && ref $a->{files} eq 'ARRAY';
    die { status => 422, error => "unsupported backup version '" . ($a->{version} // '?') . "'" }
        unless ($a->{version} // 0) == $VERSION_;
    my %seen;
    for my $f (@{ $a->{files} }) {
        die { status => 422, error => 'corrupt backup entry' } unless ref $f eq 'HASH' && defined $f->{name} && defined $f->{data};
        die { status => 422, error => "backup contains an unexpected file '$f->{name}'" } unless $GROUP_OF{ $f->{name} };
        die { status => 422, error => "duplicate entry '$f->{name}'" } if $seen{ $f->{name} }++;
        die { status => 422, error => "unknown encoding for '$f->{name}'" } unless ($f->{encoding} // '') =~ /^(?:text|base64)$/;
        my $bytes = file_bytes($f);
        die { status => 422, error => "checksum mismatch for '$f->{name}' - the backup was modified or damaged" }
            unless Digest::SHA::sha256_hex($bytes) eq ($f->{sha256} // '');
        $f->{group} = $GROUP_OF{ $f->{name} };
        $f->{bytes} = length $bytes;
    }
    return $a->{files};
}

# what a restore would do, per file: new / changed / same
sub analyze {
    my ($a, $dir) = @_;
    my @out;
    for my $f (@{ $a->{files} }) {
        my $cur = _slurp_bytes("$dir/$f->{name}");
        my $new = file_bytes($f);
        push @out, {
            name => $f->{name}, group => $f->{group}, bytes => length $new,
            secret => ($f->{group} eq 'secrets' ? 1 : 0) + 0,
            status => !defined $cur ? 'new' : $cur eq $new ? 'same' : 'changed',
        };
    }
    return \@out;
}

# write the files of the chosen groups; keeps a .bak of whatever it replaces
sub apply {
    my ($a, $dir, $parts) = @_;
    my %want = map { $_ => 1 } @$parts;
    my @written;
    for my $f (@{ $a->{files} }) {
        next unless $want{ $f->{group} };
        my $path = "$dir/$f->{name}";
        my $bytes = file_bytes($f);
        my $old = _slurp_bytes($path);
        next if defined $old && $old eq $bytes;
        if (defined $old) { _write_bytes("$path.bak", $old, $MODE{ $f->{name} }) }
        _write_bytes($path, $bytes, $MODE{ $f->{name} });
        push @written, $f->{name};
    }
    return \@written;
}

sub _write_bytes {
    my ($path, $bytes, $mode) = @_;
    my $tmp = "$path.tmp.$$";
    open my $fh, '>:raw', $tmp or die { status => 500, error => "cannot write $path: $!" };
    print $fh $bytes;
    close $fh;
    chmod(($mode // 0644), $tmp);
    rename $tmp, $path or die { status => 500, error => "cannot replace $path: $!" };
}

1;
