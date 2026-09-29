package RRDs;
# Test double for the RRDs XS module: a deterministic series with a burst of
# 20 % loss 10-40 rows before "now". Set $LAST to fake RRDs::last.
use strict;
use warnings;
our ($ROWS, $STEP, $START, $ERR, $LAST) = (8000, 10, time - 80000, undef, undef);
sub error { $ERR }
sub last  { defined $LAST ? $LAST : time - 5 }
sub fetch {
    my @n = qw(loss median ping1 ping2);
    my @d;
    for my $i (0 .. $ROWS - 1) {
        my $loss = ($i > $ROWS - 40 && $i < $ROWS - 10) ? 4 : 0;      # 4 of 20 pings = 20 %
        push @d, [ $loss, 0.01 + ($i % 5) * 0.001, 0.01, 0.012 ];
    }
    return ($START, $STEP, \@n, \@d);
}
1;
