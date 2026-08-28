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
  # Created and owned here, as root, because this is the only step in a position to do it.
  #
  # The image creates and chowns this at build time, and a volume mounted over /var/lib/postgresql at
  # run time hides that completely: the mount arrives owned by root, `data` is not in it, and nothing
  # else in the image puts either back. There is no `fix-attrs.d` under docker/s6, so the built-in
  # s6-overlay service of that name has nothing to act on. `postgres-init` is a oneshot whose `up`
  # runs as root, so it can, and `initdb` a line below cannot — it has already dropped to `postgres`.
  mkdir -p "$DATA"
  chown postgres:postgres "$DATA"

  # A volume mounted directly AT the data directory, rather than at its parent, arrives holding
  # `lost+found` on any platform whose volume is an ext4 mount — which is most of them. `initdb`
  # refuses a directory with anything in it, and its own hint says to use a subdirectory instead.
  #
  # Said here, naming this image's answer, rather than left to that hint. The failure is otherwise a
  # generic message about mount points in a container log, while `api` never starts because it depends
  # on `postgres` and `migrate`, the platform reports the deploy a success, and the public URL serves
  # a 502 with nothing on it to explain why.
  if [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
    echo "postgres-init: $DATA holds no cluster and is not empty, so initdb cannot use it." >&2
    echo "postgres-init: mount the volume at /var/lib/postgresql rather than at $DATA. A volume mounted directly on the data directory arrives with a lost+found in it, and PostgreSQL will not initialise into that." >&2
    exit 1
  fi

  s6-setuidgid postgres /usr/lib/postgresql/16/bin/initdb -D "$DATA" -A trust -U openbot >/dev/null
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/pg_ctl -D "$DATA" -o "-c listen_addresses=127.0.0.1" -w start >/dev/null
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/createdb -U openbot openbot
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/psql -U openbot -d openbot -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
  s6-setuidgid postgres /usr/lib/postgresql/16/bin/pg_ctl -D "$DATA" -w stop >/dev/null
fi
