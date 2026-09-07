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
app/apache/           Apache alias / fcgid / rewrite snippet
root/custom-cont-init.d/50-smokeping-modern
                      drops the Apache snippet into /config/site-confs on boot
root/etc/s6-overlay/s6-rc.d/svc-smokeping/run
                      upstream run script + `--logfile` so alert history is kept
config-sample/        starter Targets / Alerts / Database / Probes (10 s step)
```

### The API

Everything the API needs already lives in the base image (`perl`, `RRDs`,
`JSON::PP`, `FCGI`, the `Smokeping::*` modules). It runs under **mod_fcgid**, so
each worker parses the SmokePing config once and then serves many requests
(re-reading only when a file under `/config` changes); it falls back to plain CGI
if `mod_fcgid` is absent. It **reuses** SmokePing's own code
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

## Settings page, login, notifications

`#/settings` (also in the sidebar) is the write side of the UI. Every change is
validated with `smokeping --check` **before** it is written, a `.bak` of the previous
file is kept, and the daemon is reloaded with `SIGHUP` — no container restart.

| Tab | What it does |
|-----|--------------|
| **E-mail** | SMTP server / port / STARTTLS / credentials (writes `ssmtp.conf`), the alert `from` address and recipient list, and a **Send test e-mail** button |
| **Notifications** | Discord, Slack, Telegram, ntfy, Gotify and a generic JSON webhook — each with a **Save & send test** button. Turn on *Webhook notifications* under E-mail → Alert recipients to route alerts there (SmokePing pipes them to `bin/notify`) |
| **Add target** | form that appends a target block under a chosen group, validates, reloads |
| **Config files** | raw editor for `Targets`, `Alerts`, `Probes`, `Database`, `General`, `Presentation`, `Slaves` with validate-and-save |
| **Access** | shows who you are and how the login is configured |

**Login.** The UI, the API and the classic CGI sit behind one HTTP Basic login:

```
WEBUI_AUTH=on        # off disables it entirely
WEBUI_USER=admin
WEBUI_PASS=          # blank = a password is generated on first start,
                     # printed in the container log and kept in
                     # /config/modern-auth/password.txt
```

Mutating API calls additionally require the `X-Requested-With: modern-smokeping`
header, so a cross-site form can't ride on cached credentials.

**Acknowledgements.** *Acknowledge* on the Alerts page silences an alert
server-side (1 h / 8 h / 24 h / 7 d / until cleared, with a note and the user
who did it) — shared by everyone, stored in `/config/modern-acks.json`.

**Wall display.** `#/wall` is a chrome-less tile view for a TV: every target as a
coloured tile with current median, loss and a sparkline, plus a status header.

## What alerts should I configure?

`config-sample/Alerts` is a sensible starting set — copy it into your `/config`
(the deploy script seeds it on first run only):

| Alert | Fires when | Priority |
|-------|-----------|----------|
| `hostdown` | >90 % loss for ~1 min | 1 (critical) |
| `majorloss` | ≥25 % loss sustained ~1 min | 2 (critical) |
| `lossdetect` | ≥10 % loss for ~3 min | 6 (warning) |
| `latencyhigh` | RTT > 300 ms for ~3 min (`CheckLatency`) | 10 (warning) |
| `latencyshift` | latency > 2× the last ~10 min baseline (`Avgratio`) | 15 (warning) |

The windows in `config-sample/Alerts` are written for the **10 s step** in
`config-sample/Database` (6 cycles = 1 minute). If you raise `step`, widen the
`*N*` / `stepsraise` / `x` counts to keep the same wall-clock sensitivity.

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

## Polling interval

`config-sample/Database` sets **`step = 10`** (poll every 10 s) with an RRA layout
sized for it (24 h @ 10 s, then 5 min / 1 h / 1 day rollups). The UI auto-refreshes
every 15 s.

`step` **cannot be changed on existing `.rrd` files** — if you switch it later,
stop the container, delete `/data/**/*.rrd`, and restart (you lose history, not
config). The bundled FPing probe sets `hostinterval = 0.1` so 20 pings finish
well inside a 10 s window. To go easier on the network, raise `step` (and widen
the alert windows to match).

## Notes

* First data points appear one `step` (10 s) after the container starts;
  `30h / 10d / 360d` ranges fill in over time.
* No build step for the front end — plain ES modules and hand-rolled canvas
  charts, no npm, no CDN.
* Dashboard sparklines are embedded in `/api/summary`, so the whole grid is one
  request regardless of target count.
* `docker buildx` is not required (`deploy.sh` uses the legacy builder), which
  matters on Unraid.

## License

MIT — see [LICENSE](LICENSE). SmokePing itself is GPL-2.0 and is pulled in at
runtime from the LinuxServer.io base image; it is not redistributed here.
