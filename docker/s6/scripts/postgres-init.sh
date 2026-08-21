#!/bin/sh
# Create the cluster the first time, and only the first time.
#
# Bound to loopback and trust-auth on purpose: the only client is the process beside it, inside this
# container, and a password would be a secret with nobody to keep it from. Publishing 5432 from this
# container would change that, which is why nothing here does.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0

DATA=/var/lib/postgresql/data
if [ ! -s "$DATA/PG_VERSION" ]; then
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/initdb -D "$DATA" -A trust -U openbot >/dev/null
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/pg_ctl -D "$DATA" -o "-c listen_addresses=127.0.0.1" -w start >/dev/null
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/createdb -U openbot openbot
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/psql -U openbot -d openbot -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/pg_ctl -D "$DATA" -w stop >/dev/null
fi
