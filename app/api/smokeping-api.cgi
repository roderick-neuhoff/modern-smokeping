#!/usr/bin/perl
# SmokePing Modern UI - JSON API entry point.
#
# Runs under mod_fcgid (preferred - the SmokePing config is then parsed once per
# worker instead of once per request). FCGI::Request()->Accept() also works for a
# plain CGI invocation: it yields exactly one iteration and then -1.
# Apache maps  ScriptAlias /api  ->  this file, so /api/<route> is PATH_INFO.

use strict;
use warnings;

use FindBin ();
use lib "$FindBin::RealBin/lib";
use lib '/usr/share/smokeping';

$ENV{PATH} = '/usr/sbin:/usr/bin:/sbin:/bin';

use FCGI ();
use SmokepingModern::Api ();

my $request = FCGI::Request();
my $served  = 0;

while ($request->Accept() >= 0) {
    eval { SmokepingModern::Api::run(); 1 } or do {
        print "Status: 500\r\nContent-Type: application/json\r\n\r\n";
        print '{"error":"internal server error"}';
    };
    last if ++$served >= ($ENV{SPM_MAX_REQ} || 500);
}
