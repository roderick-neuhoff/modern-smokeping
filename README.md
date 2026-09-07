# modern-smokeping

A modern, responsive web UI — **with a real alerts page** — for
[LinuxServer.io SmokePing](https://github.com/linuxserver/docker-smokeping).

It ships as a thin Docker layer on top of `lscr.io/linuxserver/smokeping`. The
SmokePing daemon, its config format, its rrd files and its alert matchers are
untouched — this only adds a new front end and a small JSON API that reads the
same data.

|              | classic SmokePing CGI            | modern-smokeping                         |
|--------------|----------------------------------|-----------------------------------------|
| Layout       | frameset, fixed width            | responsive, mobile drawer               |
| Theme        | one light theme                  | light / dark / auto, remembered         |
| Graphs       | pre-rendered RRD PNGs            | live canvas smoke charts, hover readout  |
| Alerts       | e-mail / log only, nothing in UI | **dedicated alerts page**, live state    |
| Navigation   | full page reload per click       | single-page app, 60 s auto-refresh       |

The classic interface is still there at `/smokeping/smokeping.cgi`
(shortcut: `/smokeping/legacy`).

## Quick start

```bash
git clone https://github.com/roderick-neuhoff/modern-smokeping
cd modern-smokeping
cp .env.example .env         # set CONFIG_DIR, DATA_DIR, HTTP_PORT, TZ
./deploy.sh                  # build image + docker compose up -d
```

Then open `http://<host>:<HTTP_PORT>/` — it redirects to the dashboard.

### Replacing an existing LinuxServer SmokePing container

Point `CONFIG_DIR` / `DATA_DIR` in `.env` at the volumes your current
`linuxserver/smokeping` container already uses, stop that container, and run
`./deploy.sh`. Same config, same history, same port mapping (adjust `HTTP_PORT`).

Rollback is just starting your old container again — nothing in `/config` or
`/data` is modified in an incompatible way.

## How it works

```
Dockerfile            FROM lscr.io/linuxserver/smokeping  + the files below
app/web/              the single-page UI            -> served at /modern/  (and /)
app/api/              smokeping-api.cgi (Perl)       -> served at /api/
app/apache/           Apache alias/rewrite snippet
root/custom-cont-init.d/50-smokeping-modern
                      drops the Apache snippet into /config/site-confs on boot
root/s6-overlay/.../svc-smokeping/run
                      upstream run script + `--logfile` so alert history is kept
config-sample/        an optional starter Targets + Alerts set
```

### The API

Everything the API needs already lives in the base image (`perl`, `RRDs`,
`JSON::PP`, the `Smokeping::*` modules). It **reuses** SmokePing's own code
rather than reimplementing it:

* `Smokeping::Info` — config parsing and numeric stats from the rrd files
* `Smokeping::init_alerts` — compiles each `*** Alerts ***` entry into a coderef
  and loads the `Smokeping::matchers::*` classes
* `rrdtool` / `RRDs` — the smoke time series

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | liveness + config sanity |
| `GET /api/tree` | full target hierarchy |
| `GET /api/summary` | status counts + worst offenders + per-target now/avg |
| `GET /api/node?path=/A/B&range=3h` | stats + smoke series (`3h/30h/10d/360d`) |
| `GET /api/alerts` | **live** alert state + history parsed from the log |

### The alerts page

SmokePing has no alert database — alerts only ever existed as e-mail and log
lines. This page reconstructs the picture two ways:

1. **Active alerts** — for every target that has `alerts = …`, the API pulls the
   last *N* samples from its rrd, builds the exact data structure
   `Smokeping::check_alerts` uses (`{ loss => [%], rtt => [s] }`) and runs the
   compiled matcher. What you see is the *current* level state.
2. **History** — raise/clear events parsed from `/config/log/smokeping.log`
   (enabled by the bundled `svc-smokeping` override). Set `SMOKEPING_LOG` to
   point somewhere else.

Edge-triggered matchers (`edgetrigger = yes`) and the stateful "hold until
cleared" behaviour can't be reproduced perfectly without the daemon's in-memory
state, so treat *Active alerts* as "is this true right now", and *History* as
the authoritative raise/clear record.

Rows can be **silenced** (client-side, stored in your browser) to drop known
issues out of the top-bar counts.

## What alerts should I configure?

`config-sample/Alerts` is a sensible starting set — copy it into your `/config`
(the deploy script seeds it on first run only):

| Alert | Fires when | Priority |
|-------|-----------|----------|
| `hostdown` | >90 % loss for 2 cycles in a row | 1 (critical) |
| `majorloss` | ≥25 % loss in a single cycle | 2 (critical) |
| `lossdetect` | ≥10 % loss for 3 cycles in a row | 6 (warning) |
| `latencyhigh` | RTT > 300 ms for 3+ cycles (`CheckLatency`) | 10 (warning) |
| `latencyshift` | current latency > 2× the recent baseline (`Avgratio`) | 15 (warning) |

Attach them per target (or once at the top of `Targets`):

```
+ WAN
alerts = hostdown,majorloss,lossdetect,latencyhigh,latencyshift
```

`CheckLatency`'s `l` is in **milliseconds**. The modern UI maps priority ≤ 2 to
*critical*, everything else to *warning*; a target at 100 % loss with no matching
alert still shows as *down*.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `HTTP_PORT` | `8480` | host port (container listens on 80) |
| `CONFIG_DIR` | `/mnt/user/appdata/smokeping/config` | → `/config` |
| `DATA_DIR` | `/mnt/user/appdata/smokeping/data` | → `/data` |
| `PUID` / `PGID` | `99` / `100` | LinuxServer user mapping (Unraid defaults) |
| `TZ` | `Europe/Amsterdam` | container timezone |
| `BASE_TAG` | `latest` | `lscr.io/linuxserver/smokeping` tag to build on |
| `SMOKEPING_LOG` | `/config/log/smokeping.log` | alert-history log the API reads |

## Notes

* First data points appear one `step` (default 5 min) after the container
  starts; `30h/10d/360d` ranges fill in over time.
* No build step for the front end — plain ES modules and hand-rolled canvas
  charts, no npm, no CDN.
* `docker buildx` is not required (`deploy.sh` uses the legacy builder), which
  matters on Unraid.

## License

MIT — see [LICENSE](LICENSE). SmokePing itself is GPL-2.0 and is pulled in at
runtime from the LinuxServer.io base image; it is not redistributed here.
