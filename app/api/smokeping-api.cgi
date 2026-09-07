#!/usr/bin/perl
# SmokePing Modern UI - JSON API entry point.
# Apache maps  ScriptAlias /api  ->  this file, so /api/<route> arrives as PATH_INFO.

use strict;
use warnings;

use FindBin ();
use lib "$FindBin::RealBin/lib";
use lib '/usr/share/smokeping';

$ENV{PATH} = '/usr/sbin:/usr/bin:/sbin:/bin';

use SmokepingModern::Api ();

SmokepingModern::Api::run();
