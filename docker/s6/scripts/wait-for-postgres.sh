#!/bin/sh
# Wait until the embedded database accepts connections.
#
# s6 counts `postgres` as started the moment its process exists, not when it can take a
# connection, so anything that depends on it starts while Postgres is still replaying its log.
# `migrate` used to connect in that window, get "the database system is starting up", exit 1, and
# s6 does not retry a oneshot: the container came up with no server and never answered.
#
# `pg_isready` exits 0 when the server accepts connections, 1 while it is starting or shutting
# down, and 2 when nothing answers yet. Anything but 0 means wait. The bound is generous because a
# first boot also runs initdb, and a failure here should say what it waited for.
set -eu
pg_isready="${PG_ISREADY:-/usr/lib/postgresql/16/bin/pg_isready}"
seconds="${POSTGRES_WAIT_SECONDS:-60}"
waited=0
until "$pg_isready" -q -h 127.0.0.1 -p 5432; do
  if [ "$waited" -ge "$((seconds * 2))" ]; then
    echo "Postgres did not accept connections on 127.0.0.1:5432 within ${seconds}s." >&2
    exit 1
  fi
  waited=$((waited + 1))
  sleep 0.5
done
