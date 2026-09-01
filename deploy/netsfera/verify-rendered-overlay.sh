#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf '%s\n' "usage: verify-rendered-overlay.sh BASE_RENDER CANDIDATE_RENDER" >&2
  exit 64
fi

base_render=$1
candidate_render=$2
for rendered in "$base_render" "$candidate_render"; do
  test -f "$rendered"
  test "$(stat -c '%a' "$rendered")" = "600"
done

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
policy_path="$script_directory/agent-computer-policy.json"
compose=(
  docker compose
  --env-file /opt/openbot/.env
  --env-file /etc/netsfera/bot-zero-trust/erp-phase2.env
  -f /opt/openbot/docker-compose.yml
  -f /opt/openbot/docker-compose.browser-supervisor.yml
  -f /opt/openbot/docker-compose.erp-phase2.yml
)

"${compose[@]}" config --format json >"$base_render"
"${compose[@]}" -f /opt/openbot/source/deploy/netsfera/docker-compose.erp-agent.yml \
  config --format json >"$candidate_render"

expected_policy="$(jq -cS . "$policy_path")"
if ! jq -e --arg expected_policy "$expected_policy" '
  .services.openbot as $openbot
  | ($openbot.build.args.TENANT_PACKAGE_DIR == "../examples/netsfera")
  and ($openbot.environment.TENANT_PACKAGE_DIR == "../examples/netsfera")
  and (($openbot.environment.AGENT_COMPUTER_POLICY | fromjson) == ($expected_policy | fromjson))
' "$candidate_render" >/dev/null; then
  printf '%s\n' "G0 rendered-stack verification failed." >&2
  exit 1
fi

normalize_approved_differences='
  del(
    .services.openbot.build.args.TENANT_PACKAGE_DIR,
    .services.openbot.environment.TENANT_PACKAGE_DIR,
    .services.openbot.environment.AGENT_COMPUTER_POLICY
  )
  | if .services.openbot.build.args == {} then del(.services.openbot.build.args) else . end
  | if .services.openbot.environment == {} then del(.services.openbot.environment) else . end
'
base_hash="$(jq -S "$normalize_approved_differences" "$base_render" | sha256sum | awk '{print $1}')"
candidate_hash="$(jq -S "$normalize_approved_differences" "$candidate_render" | sha256sum | awk '{print $1}')"
if [ "$base_hash" != "$candidate_hash" ]; then
  printf '%s\n' "G0 rendered-stack verification failed: unreviewed rendered-stack change." >&2
  exit 1
fi

candidate_render_hash="$(sha256sum "$candidate_render" | awk '{print $1}')"
printf 'verified private candidate render SHA-256: %s\n' "$candidate_render_hash"
