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

COPY app/ /app/smokeping-modern/
COPY root/ /

RUN chmod +x /app/smokeping-modern/api/smokeping-api.cgi \
             /custom-cont-init.d/50-smokeping-modern \
             /etc/s6-overlay/s6-rc.d/svc-smokeping/run

LABEL org.opencontainers.image.title="modern-smokeping" \
      org.opencontainers.image.description="Modern responsive UI + alerts page for LinuxServer SmokePing" \
      org.opencontainers.image.source="https://github.com/roderick-neuhoff/modern-smokeping"
