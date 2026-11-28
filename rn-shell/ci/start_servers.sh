#!/usr/bin/env bash
# Builds this branch's web app (unless app/dist came from the cache) and starts what the UI tests talk
# to, from the repository root: mock stack A (with the sign-in hand-off) on 3010, mock stack B
# (without) on 3011, and rn-shell/ci/test_servers.py (3013 silent, 3014 502, 8790/8791 header probe).
# Writes $1/servers.ready when everything answers, $1/servers.failed otherwise. Meant to run in the
# background while the app builds.
set -uo pipefail
ART="${1:?artifacts dir}"
mkdir -p "$ART"
rm -f "$ART/servers.ready" "$ART/servers.failed"
started=$SECONDS
{
  bun install --frozen-lockfile > "$ART/bun-install.log" 2>&1 || { echo "bun install failed"; tail -n 30 "$ART/bun-install.log"; touch "$ART/servers.failed"; exit 1; }
  cp .env.example .env
  if [ -f app/dist/index.html ]; then
    echo "web app from the cache"
  else
    (cd app && bun run build) > "$ART/web-build.log" 2>&1 || { echo "web build failed"; tail -n 40 "$ART/web-build.log"; touch "$ART/servers.failed"; exit 1; }
  fi
  echo "web app ready after $((SECONDS - started)) s"
  MOCK_REPLY=1 MOCK_SIGNED_OUT=1 SERVER_PORT=3001 nohup bun app/workbench/mock-server.ts > "$ART/mock-a.log" 2>&1 &
  APP_PORT=3010 SERVER_PORT=3001 nohup bun app/serve.ts > "$ART/app-a.log" 2>&1 &
  MOCK_NO_HANDOFF=1 MOCK_SIGNED_OUT=1 SERVER_PORT=3002 nohup bun app/workbench/mock-server.ts > "$ART/mock-b.log" 2>&1 &
  APP_PORT=3011 SERVER_PORT=3002 nohup bun app/serve.ts > "$ART/app-b.log" 2>&1 &
  nohup python3 rn-shell/ci/test_servers.py > "$ART/test-servers.log" 2>&1 &
  challenge="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  for _ in $(seq 1 90); do
    a_page="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/ || true)"
    b_page="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3011/ || true)"
    a_handoff="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3010/api/auth/shell/handoff?challenge=$challenge" || true)"
    b_config="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3011/api/auth/shell/config?platform=ios" || true)"
    probe="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/report || true)"
    bad="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3014/ || true)"
    if [ "$a_page" = 200 ] && [ "$b_page" = 200 ] && [ "$a_handoff" = 200 ] && [ "$b_config" = 404 ] && [ "$probe" = 200 ] && [ "$bad" = 502 ]; then
      # Warm the mock's answers so the first page in the app is not the slowest.
      for path in deployment people/me conversations "bots?limit=50" plan; do
        curl -s -o /dev/null -b better-auth.session_token=mock "http://127.0.0.1:3010/api/v2/organizations/default/$path" || true
      done
      echo "servers up after $((SECONDS - started)) s"
      touch "$ART/servers.ready"
      exit 0
    fi
    sleep 1
  done
  echo "servers did not start: A $a_page/$a_handoff, B $b_page/$b_config, probe $probe, 502 $bad"
  tail -n 30 "$ART"/mock-a.log "$ART"/app-a.log "$ART"/mock-b.log "$ART"/app-b.log "$ART"/test-servers.log
  touch "$ART/servers.failed"
  exit 1
} > "$ART/servers.log" 2>&1
