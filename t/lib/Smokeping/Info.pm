package Smokeping::Info;
# Test double: three targets in two groups, 10 s step.
use strict;
use warnings;
sub new {
    my ($class) = @_;
    return bless {
        cfg_hash => {
            Database => { step => 10, pings => 20 },
            General  => { datadir => $ENV{SPM_TEST_DATADIR} },
            Alerts   => {},
            Targets  => {
                title => 'T',
                Sites => { _order => 1,
                           Google => { _order => 1, host => '8.8.8.8', title => 'Google' },
                           Cf     => { _order => 2, host => '1.1.1.1', title => 'Cloudflare' } },
                Top   => { _order => 2, host => '9.9.9.9', title => 'Quad9' },
            },
        },
        probe_hash => {},
    }, $class;
}
sub stat_node   { { loss_now => 0.05, med_now => 0.012, med_avg => 0.011 } }
sub fetch_nodes { [] }
1;
