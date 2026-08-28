#!/command/with-contenv sh
# Create the cluster the first time, and hand the API a password every time.
#
# Bound to loopback, but no longer trust-auth. The process beside it is not the only client: the
# Bot's shell runs in this same container, and under trust it could `psql -h 127.0.0.1 -U openbot`
# with no password and reach the audit trail, the policy store, and the credential vault as the
# instance owner. A generated password closes that: the shell has no way to learn it (its own
# environment is an allow-list that does not carry the URL), and scram refuses a connection without
# it. The password lives beside the data on the same volume, so it survives a restart the way the
# data does.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0

DATA=/var/lib/postgresql/data
PW_FILE=/var/lib/postgresql/pgpassword
BIN=/usr/lib/postgresql/16/bin

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

  # The cluster's password, generated once and kept on the same volume as the data. openssl is not in
  # this image; /dev/urandom is. 600 and owned by postgres, so the Bot's shell (which runs as pwuser)
  # cannot read the file even if it goes looking.
  PW="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  ( umask 077; printf '%s' "$PW" > "$PW_FILE" )
  chown postgres:postgres "$PW_FILE"

  # initdb reads the superuser password from a file (never an argument, which would show in `ps`), and
  # sets scram for both local and TCP connections. The temp file is removed the moment initdb returns.
  PWTMP="$(mktemp)"
  printf '%s' "$PW" > "$PWTMP"
  chown postgres:postgres "$PWTMP"
  s6-setuidgid postgres "$BIN/initdb" -D "$DATA" -A scram-sha-256 -U openbot --pwfile="$PWTMP" >/dev/null
  rm -f "$PWTMP"

  s6-setuidgid postgres "$BIN/pg_ctl" -D "$DATA" -o "-c listen_addresses=127.0.0.1" -w start >/dev/null
  # Over TCP with the password now, since the cluster no longer trusts an unauthenticated connection.
  PGPASSWORD="$PW" s6-setuidgid postgres "$BIN/createdb" -h 127.0.0.1 -U openbot openbot
  PGPASSWORD="$PW" s6-setuidgid postgres "$BIN/psql" -h 127.0.0.1 -U openbot -d openbot -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
  s6-setuidgid postgres "$BIN/pg_ctl" -D "$DATA" -w stop >/dev/null
fi

# Every boot, not only the first: hand the password-bearing URL to the services that connect over TCP
# (`api` and `migrate`, both `with-contenv`). The password persists with the cluster; the container
# environment is fresh each boot, so this has to run outside the first-init guard above. The file is
# root-written here into s6's own environment directory, which pwuser cannot write and the Bot's shell
# does not read.
if [ -s "$PW_FILE" ]; then
  PW="$(cat "$PW_FILE")"
  printf 'postgres://openbot:%s@127.0.0.1:5432/openbot' "$PW" \
    > /run/s6/container_environment/DATABASE_URL
fi
