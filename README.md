# modern-smokeping

A modern, responsive web UI for [SmokePing](https://oetiker.github.io/SmokePing/) —
with a **real alerts page**, a **settings page** (SMTP, webhooks, targets, config
editor), server-side acknowledgements and a wall display — packaged as a thin
Docker layer on top of the official
[LinuxServer.io SmokePing image](https://github.com/linuxserver/docker-smokeping).

The SmokePing daemon, its config format, its `.rrd` files and its alert matchers
are untouched. This adds a front end and a small JSON API that read (and, behind a
password, write) the same files. The classic CGI stays reachable at
`/smokeping/smokeping.cgi`.

|              | classic SmokePing CGI            | modern-smokeping                                    |
|--------------|----------------------------------|-----------------------------------------------------|
| Layout       | frameset, fixed width            | responsive, mobile drawer, light / dark / auto      |
| Graphs       | pre-rendered PNGs                | live canvas smoke charts, hover readout, drag-zoom  |
| Alerts       | e-mail / log only                | **alerts page**: live state, history, acknowledgements |
| Config       | edit files by hand               | **settings page**: SMTP, Discord/Telegram/ntfy/…, add & remove targets, validated config editor |
| Navigation   | full page reload per click       | single-page app, 15 s auto-refresh, wall display    |

---

## Deploy

### Requirements

* Docker with the `docker compose` plugin (v2). Nothing is built on the host —
  `deploy.sh` just pulls the published image, so `docker buildx` is not needed
  even on Unraid.
* Outbound network from the host to pull `ghcr.io/roderick-neuhoff/modern-smokeping`.
* One free TCP port (default `8480`). On Unraid, 80 and 443 belong to the web UI.

### 1. Get the code

```bash
git clone https://github.com/roderick-neuhoff/modern-smokeping
cd modern-smokeping
cp .env.example .env
```

### 2. Edit `.env`

```ini
# image tag to pull from ghcr.io/roderick-neuhoff/modern-smokeping
IMAGE_TAG=latest          # or pin a version: 1.2.3 / 1.2 / 1

# where SmokePing keeps its config and its rrd data on the host
CONFIG_DIR=/mnt/user/appdata/smokeping/config
DATA_DIR=/mnt/user/appdata/smokeping/data

HTTP_PORT=8480            # host port; the container listens on 80
PUID=99                   # user/group the files are owned by (99/100 = Unraid "nobody:users")
PGID=100
TZ=Europe/Amsterdam

# password for the Settings page and every write (viewing stays open)
WEBUI_AUTH=on             # off = no login anywhere
WEBUI_USER=admin
WEBUI_PASS=               # blank = generated on first start (see step 4)
```

`CONFIG_DIR` and `DATA_DIR` are created if missing. If you already run
`linuxserver/smokeping`, point them at **its** volumes — see
[Migrating](#migrating-from-linuxserversmokeping).

### 3. Pull and start

```bash
./deploy.sh
```

The script:

1. creates the two directories,
2. seeds `config-sample/*` (Targets, Alerts, Database, Probes) into `CONFIG_DIR` —
   **only for files that don't exist yet**, it never overwrites,
3. pulls `IMAGE_TAG` from `ghcr.io/roderick-neuhoff/modern-smokeping` (built by
   GitHub Actions — nothing is built on the host, so no buildx needed even on
   Unraid),
4. runs `docker compose up -d`.

Without the script:

```bash
docker compose pull
docker compose up -d
```

### 4. First login

Open `http://<host>:8480/` — it redirects to the dashboard. Everything is viewable
without a password. The first time you open **Settings** (or acknowledge an
alert) you're asked for one:

```bash
docker logs smokeping 2>&1 | grep "generated login"
# [smokeping-modern] generated login: user=admin password=XXXXXXXXXXXXXX
#   (saved to /config/modern-auth/password.txt)
```

or `cat $CONFIG_DIR/modern-auth/password.txt`. To choose your own, set
`WEBUI_PASS` in `.env` and `docker compose up -d`.

First data points appear one poll cycle (10 s) after start; the `30h / 10d / 360d`
ranges fill in over time.

### 5. Verify

```bash
curl -s http://<host>:8480/api/health          # {"ok":true, "targets":8, ...}
curl -s http://<host>:8480/api/summary | head -c 300
docker exec smokeping tail -f /config/log/smokeping.log
```

---

## Upgrading

```bash
cd modern-smokeping
./deploy.sh
```

`deploy.sh` pulls the current `IMAGE_TAG` and `docker compose up -d`
**recreates** the container (a plain `docker restart` would keep running the
old image). Your `/config` and `/data` are volumes and survive; the Apache
snippet and the `svc-smokeping` override are reinstalled from the image on
every start.

To pin a specific version instead of always tracking `latest`, set
`IMAGE_TAG` in `.env` (e.g. `IMAGE_TAG=1.2.3`) before redeploying.

## Versioning / releases

Images are built and published automatically by GitHub Actions
(`.github/workflows/docker-publish.yml`) to
[`ghcr.io/roderick-neuhoff/modern-smokeping`](https://github.com/roderick-neuhoff/modern-smokeping/pkgs/container/modern-smokeping) —
nothing is built locally or on the deploy host.

* Every push to `main` publishes/updates the `latest` tag.
* Pushing a version tag (`git tag v1.2.3 && git push --tags`) builds a
  multi-arch (amd64/arm64) image and publishes it as `1.2.3`, `1.2` and `1`,
  and creates a GitHub Release with auto-generated notes.

The image is always built `FROM lscr.io/linuxserver/smokeping:<tag>` — by
default `latest`. To follow a different SmokePing base:

* set it repo-wide: **Settings → Secrets and variables → Actions → Variables**,
  add `BASE_TAG` (e.g. `2.7.4`) — every push/tag build then uses it, or
* one-off: **Actions → Build and publish Docker image → Run workflow**, fill in
  *base_tag*.

To release a new version:

```bash
git tag v1.2.3
git push --tags
```

Then set `IMAGE_TAG=1.2.3` in `.env` on hosts that should pick it up, and run
`./deploy.sh`.

## Rollback

Nothing in `/config` or `/data` is changed in a way the stock image can't read.
To go back to plain LinuxServer SmokePing:

```bash
docker compose down
docker run -d --name smokeping -p 8480:80 -e PUID=99 -e PGID=100 -e TZ=Europe/Amsterdam \
  -v $CONFIG_DIR:/config -v $DATA_DIR:/data lscr.io/linuxserver/smokeping:latest
```

The extra files this project leaves in `/config` are harmless to the stock
image: `site-confs/zz-smokeping-modern.conf`, `site-confs/modern-auth.inc`,
`modern-auth/`, `modern-notify.json`, `modern-acks.json`, `log/`. Remove
`site-confs/zz-smokeping-modern.conf` and `site-confs/modern-auth.inc` if you
want the stock Apache config back exactly.

## Migrating from linuxserver/smokeping

1. Stop the old container (`docker stop <name>`).
2. Set `CONFIG_DIR` / `DATA_DIR` in `.env` to the paths it used for `/config` and
   `/data`, and `HTTP_PORT` to the port you had.
3. `./deploy.sh`.

Your targets, alerts, and all rrd history carry over unchanged. The sample
config is **not** applied because your files already exist.

> **Polling interval.** The bundled sample uses `step = 10` (poll every 10 s).
> A migrated install keeps whatever `step` it had. Changing `step` later requires
> deleting the `.rrd` files (rrdtool cannot re-step them) — see
> [Polling interval](#polling-interval).

## Backups

Back up **`CONFIG_DIR`** (targets, alerts, SMTP settings, notification channels,
acks, the login hash) and **`DATA_DIR`** (the rrd history). Both are plain
directories — `tar`/`rsync` them; stop the container first if you want the rrd
files quiescent, otherwise expect the last few seconds to be missing.

---

## Using it

### Dashboard / target pages

Cards per target with a loss-coloured sparkline; click one for the full smoke
chart (median coloured by loss, symmetric min–max / p10–p90 / p20–p80 smoke).
**Drag** on the chart to zoom into any window, **double-click** to reset. Ranges
`3h / 30h / 10d / 360d`. The ⏸ button in the top bar pauses auto-refresh per
browser; the refresh button always works.

### Alerts page

SmokePing has no alert database — alerts only exist as e-mail and log lines. This
page reconstructs both:

* **Active** — every target's `alerts = …` matchers are run against the latest
  rrd samples exactly the way `Smokeping::check_alerts` does. "Is it true right now."
* **History** — raise/clear events parsed from `/config/log/smokeping.log`
  (the bundled `svc-smokeping` override adds `--logfile`).
* **Acknowledge** — silence for 1 h / 8 h / 24 h / 7 d / until cleared, with a note
  and who did it. Server-side, shared by everyone (`/config/modern-acks.json`).

### Settings page (`#/settings`, password)

Every change is validated with `smokeping --check` **before** it is written, a
`.bak` of the previous file is kept, and the daemon is reloaded with `SIGHUP`. No
container restart.

| Tab | |
|-----|---|
| **E-mail** | SMTP server / port / STARTTLS / TLS, sign-in method **password or OAuth2** (Google, Microsoft 365), alert *from* + recipient list, **Send test e-mail** — see [E-mail: OAuth2](#e-mail-oauth2) |
| **Notifications** | Discord, Slack, Telegram, ntfy, Gotify, generic JSON webhook — each with **Save & send test**. Enable *Webhook notifications* on the E-mail tab to route alerts there |
| **Targets** | **Add** a target under any group. **Remove** a target or a whole group — asks for the password *again* and verifies it server-side; optionally deletes the rrd data |
| **Config files** | raw editor for `Targets`, `Alerts`, `Probes`, `Database`, `General`, `Presentation`, `Slaves`; nothing is saved if the check fails |
| **Access** | who you are, how the login is set, **Sign out** |

Auto-refresh is off on this page so it can never wipe a half-filled form.

### E-mail: OAuth2

Alert mail goes out through **msmtp** (added to the image), configured from
Settings → E-mail. Three sign-in methods:

* **Password / app password** — classic SMTP AUTH. Gmail needs an *app password*
  (2-step verification on).
* **OAuth2 — Google / Gmail.** Google has no device sign-in for the Gmail scope, so
  it's a one-time manual dance: create an OAuth client (type *Desktop app*) in
  Google Cloud Console and enable the Gmail API; open the
  [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), tick
  *Use your own OAuth credentials*, authorize scope `https://mail.google.com/`,
  exchange for tokens; paste client ID, client secret and **refresh token** into
  the form. The mailbox is the account you authorized.
* **OAuth2 — Microsoft 365 / Outlook.** Register an app in Entra ID as a *public
  client* with the delegated permission `https://outlook.office365.com/SMTP.Send`
  and *Allow public client flows* = Yes; make sure SMTP AUTH is enabled for the
  mailbox in Exchange admin. In the form enter the application (client) ID and
  tenant, click **Connect with Microsoft**, open the URL it shows, type the code,
  sign in — the refresh token and mailbox are stored automatically.

Under the hood: `msmtp` uses `auth xoauth2` with
`passwordeval bin/oauth-token`, which exchanges the stored refresh token for an
access token (cached in `/tmp` until near expiry). Secrets live in
`/config/modern-oauth.json` (0600) and `/config/msmtp.conf` (0600). **Check
token** proves the credentials without sending mail; **Forget OAuth2** wipes them.
On first save `pathnames` is switched to `sendmail = /app/smokeping-modern/bin/sendmail`
(the msmtp wrapper); until then a legacy `ssmtp.conf` keeps working.

### Wall display (`#/wall`)

Chrome-less tile view for a TV: every target as a coloured tile with median,
loss and sparkline, plus a status header and clock. Always live (ignores pause).

---

## Configuration reference

### Environment (`.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `HTTP_PORT` | `8480` | host port (container listens on 80) |
| `CONFIG_DIR` | `/mnt/user/appdata/smokeping/config` | mounted at `/config` |
| `DATA_DIR` | `/mnt/user/appdata/smokeping/data` | mounted at `/data` |
| `PUID` / `PGID` | `99` / `100` | file ownership inside the volumes |
| `TZ` | `Europe/Amsterdam` | container timezone |
| `WEBUI_AUTH` | `on` | `off` disables the login entirely |
| `WEBUI_USER` | `admin` | login user |
| `WEBUI_PASS` | *(blank)* | login password; blank = generated once |
| `IMAGE_TAG` | `latest` | tag pulled from `ghcr.io/roderick-neuhoff/modern-smokeping` |
| `SMOKEPING_LOG` | `/config/log/smokeping.log` | alert-history log the API parses |

### Files in `/config` this project adds or manages

| Path | Purpose |
|------|---------|
| `site-confs/zz-smokeping-modern.conf` | Apache: `/modern`, `/api`, redirects (reinstalled every start) |
| `site-confs/modern-auth.inc` | Apache: which routes need the password (regenerated every start) |
| `modern-auth/htpasswd`, `modern-auth/password.txt` | login hash; generated password |
| `ssmtp.conf` | SMTP (edited by Settings → E-mail; symlinked to `/etc/ssmtp/ssmtp.conf`) |
| `modern-notify.json` | webhook channels (Settings → Notifications) |
| `modern-acks.json` | acknowledgements |
| `log/smokeping.log`, `log/notify.log` | alert history; notifier log |
| `Targets.bak`, `Alerts.bak`, … | previous version of any file saved through the UI |

### Sample alerts (`config-sample/Alerts`)

Written for the 10 s step (6 cycles = 1 minute):

| Alert | Fires when | Priority |
|-------|-----------|----------|
| `hostdown` | >90 % loss for ~1 min | 1 (critical) |
| `majorloss` | ≥25 % loss sustained ~1 min | 2 (critical) |
| `lossdetect` | ≥10 % loss for ~3 min | 6 (warning) |
| `latencyhigh` | RTT > 300 ms for ~3 min (`CheckLatency`, `l` in ms) | 10 (warning) |
| `latencyshift` | latency > 2× the last ~10 min baseline (`Avgratio`) | 15 (warning) |

Attach per target or once at the top of `Targets`:
`alerts = hostdown,majorloss,lossdetect,latencyhigh,latencyshift`.
The UI maps priority ≤ 2 to *critical*, the rest to *warning*; 100 % loss with no
matching alert still shows *down*. If you raise `step`, widen the cycle counts.

### Polling interval

`config-sample/Database` sets `step = 10` with an RRA layout sized for it
(24 h @ 10 s, then 5 min / 1 h / 1 day rollups); the FPing probe uses
`hostinterval = 0.1` so 20 pings fit the window. **`step` cannot be changed on
existing `.rrd` files** — to change it: stop the container, delete
`DATA_DIR/**/*.rrd`, edit `Database`, start. You lose history, not config.

---

## Security notes

* Viewing is intentionally open; the password guards writes only. If the port is
  reachable from anywhere you don't trust, put it behind a reverse proxy with TLS
  and its own auth — HTTP Basic over plain HTTP is not secure on a hostile network.
* Mutating API calls need the `X-Requested-With: modern-smokeping` header, so a
  cross-site form can't ride on cached credentials.
* Removing a target re-verifies the password against the htpasswd file for that
  request, independent of the session.
* The SMTP password is stored in `/config/ssmtp.conf` (mode 0640) — that's how
  ssmtp works; back it up accordingly.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Dashboard empty / "collecting…" | data starts one `step` after boot; `docker exec smokeping tail /config/log/smokeping.log` should show `probing N targets` |
| "API unreachable" banner | the line under it names the endpoint + error; `curl http://<host>:8480/api/health` |
| Settings says the check failed | the output shows the exact line SmokePing rejected; nothing was written |
| Lost the password | `cat $CONFIG_DIR/modern-auth/password.txt`, or set `WEBUI_PASS` and `docker compose up -d` |
| Test e-mail fails | the ssmtp error is shown verbatim (e.g. Gmail needs an app password with 2FA) |
| Notification test fails | `docker exec smokeping tail /config/log/notify.log` |
| Changed a file by hand, UI not reflecting it | the API re-reads automatically when a file under `/config` changes. The daemon does not — reload it with `curl -u admin:PASS -H 'X-Requested-With: modern-smokeping' -X POST http://<host>:8480/api/reload` (validates first), or re-save the file in Settings → Config files. (`smokeping --reload` does **not** work in this image: the daemon writes no pid file.) |
| Rebuilt but nothing changed | `docker restart` keeps the old image — use `./deploy.sh` / `docker compose up -d` |

## How it works

```
.github/workflows/docker-publish.yml   builds + publishes the image to ghcr.io on push/tag
Dockerfile                      FROM lscr.io/linuxserver/smokeping + the files below
app/web/                        single-page UI (plain ES modules, canvas charts, no build step)  -> /modern/ and /
app/api/smokeping-api.cgi       JSON API, runs under mod_fcgid                                -> /api/
app/api/lib/SmokepingModern/    Api.pm (read: tree, summary, node, alerts)  Admin.pm (write: settings, config, targets, acks)
app/bin/notify                  webhook notifier, invoked by SmokePing as a |script alertee
app/apache/                     Apache alias / fcgid / rewrite snippet
root/custom-cont-init.d/        installs the snippet + login on every start
root/etc/s6-overlay/.../svc-smokeping/run   upstream run script + --logfile
config-sample/                  starter Targets / Alerts / Database / Probes (10 s step)
```

The API reuses SmokePing's own Perl — `Smokeping::Info` for config parsing and rrd
stats, `Smokeping::init_alerts` for the compiled matchers, `RRDs` for the series —
rather than reimplementing any of it.

| Endpoint | |
|----------|---|
| `GET /api/health` `tree` `summary` `alerts` `acks` | open |
| `GET /api/node?path=&range=` or `&start=&end=` | open |
| `GET /api/settings` `me` `config/<file>` | password |
| `POST /api/settings/{smtp,notify}` `config/<file>` `targets/{add,remove}` `test/{mail,notify}` `reload` `acks` `acks/delete` | password + `X-Requested-With` |

## License

MIT — see [LICENSE](LICENSE). SmokePing itself is GPL-2.0 and is pulled in at
runtime from the LinuxServer.io base image; it is not redistributed here.
