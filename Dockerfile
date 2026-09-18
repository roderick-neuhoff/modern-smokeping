# SmokePing Modern UI - a thin layer on top of the LinuxServer.io image.
#
# It adds:
#   * /app/smokeping-modern/web   - the single-page UI (served at /modern/)
#   * /app/smokeping-modern/api   - a Perl JSON API (served at /api/)  that
#                                   reuses SmokePing's own config parser,
#                                   alert matchers and rrd files
#   * a custom-init script that drops an Apache vhost snippet into
#     /config/site-confs and makes /modern/ the landing page
#   * an svc-smokeping override that enables --logfile for alert history
#
# Everything the API needs (perl, RRDs, JSON::PP, the Smokeping::* modules)
# already ships in the base image.

ARG BASE_TAG=latest
FROM lscr.io/linuxserver/smokeping:${BASE_TAG}

# msmtp replaces ssmtp for outgoing mail: it can do OAuth2 (XOAUTH2) for
# Gmail / Microsoft 365 via passwordeval, as well as plain passwords.
RUN apk add --no-cache msmtp

COPY app/ /app/smokeping-modern/
COPY root/ /

# Stamps the release into the UI (topbar + wallboard) at build time - the
# web files are plain static assets with no JS build step, so this sed is
# the whole "build". docker-publish.yml sets APP_VERSION from the git tag
# (or "latest-<sha>" for a plain push to main).
ARG APP_VERSION=dev
RUN sed -i "s/__APP_VERSION__/${APP_VERSION}/" /app/smokeping-modern/web/index.html \
 && sed -i "s/__APP_VERSION__/${APP_VERSION}/" /app/smokeping-modern/api/lib/SmokepingModern/Api.pm

RUN chmod +x /app/smokeping-modern/api/smokeping-api.cgi \
             /app/smokeping-modern/bin/notify \
             /app/smokeping-modern/bin/sendmail \
             /app/smokeping-modern/bin/oauth-token \
             /app/smokeping-modern/bin/graph-send \
             /app/smokeping-modern/bin/maint-check \
             /custom-cont-init.d/50-smokeping-modern \
             /etc/s6-overlay/s6-rc.d/svc-smokeping/run

LABEL org.opencontainers.image.title="modern-smokeping" \
      org.opencontainers.image.description="Modern responsive UI + alerts page for LinuxServer SmokePing" \
      org.opencontainers.image.source="https://github.com/roderick-neuhoff/modern-smokeping" \
      org.opencontainers.image.version="${APP_VERSION}"
