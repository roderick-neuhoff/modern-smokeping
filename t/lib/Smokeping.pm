package Smokeping;
# Test double: compiles only ConsecutiveLoss(pctlossraise=>P,stepsraise=>N,...)
use strict;
use warnings;
sub init_alerts {
    my $c = shift;
    for my $k (keys %{ $c->{Alerts} }) {
        my $a = $c->{Alerts}{$k};
        die "bad pattern\n" unless $a->{pattern} =~ /ConsecutiveLoss\(pctlossraise=>(\d+),stepsraise=>(\d+)/;
        my ($p, $n) = ($1, $2);
        $a->{maxlength} = $n;
        $a->{sub} = sub {
            my @l = @{ $_[0]{loss} };
            return 0 if @l < $n;
            for (@l[-$n .. -1]) { return 0 unless defined $_ && $_ >= $p }
            return 1;
        };
    }
    return 1;
}
1;
