#!/usr/bin/env bash
set -euo pipefail

umask 077
base_render="$(mktemp)"
g0_render="$(mktemp)"
cleanup() {
  rm -f "$base_render" "$g0_render"
}
trap cleanup EXIT HUP INT TERM

for rendered in "$base_render" "$g0_render"; do
  test "$(stat -c '%a' "$rendered")" = "600"
done

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
  config --format json >"$g0_render"

bun - "$base_render" "$g0_render" <<'EOF'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [basePath, g0Path] = process.argv.slice(2);
const base = JSON.parse(readFileSync(basePath, "utf8")).services?.openbot;
const g0 = JSON.parse(readFileSync(g0Path, "utf8")).services?.openbot;
if (!base || !g0) throw new Error("openbot service is absent from a rendered stack");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const changedPaths = (before, after, prefix = "") => {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isObject(before) || isObject(after)) {
    const left = isObject(before) ? before : {};
    const right = isObject(after) ? after : {};
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      changedPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
};
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const pick = (service, keys) => Object.fromEntries(keys.map((key) => [key, service[key]]));
const allowed = new Set([
  "build.args.TENANT_PACKAGE_DIR",
  "environment.TENANT_PACKAGE_DIR",
  "environment.AGENT_COMPUTER_POLICY",
]);
const changes = changedPaths(base, g0);
if (changes.length !== allowed.size || changes.some((change) => !allowed.has(change))) {
  throw new Error("rendered G0 overlay changes an unreviewed OpenBot setting");
}
const topologyKeys = [
  "container_name",
  "depends_on",
  "dns",
  "expose",
  "extra_hosts",
  "hostname",
  "image",
  "labels",
  "network_mode",
  "networks",
  "ports",
  "restart",
  "volumes",
];
const securityKeys = [
  "cap_add",
  "cap_drop",
  "devices",
  "group_add",
  "privileged",
  "read_only",
  "security_opt",
  "user",
];
const normalizeConfiguration = (service) => {
  const normalized = structuredClone(service);
  delete normalized.build?.args?.TENANT_PACKAGE_DIR;
  if (normalized.build?.args && Object.keys(normalized.build.args).length === 0) {
    delete normalized.build.args;
  }
  delete normalized.environment?.TENANT_PACKAGE_DIR;
  delete normalized.environment?.AGENT_COMPUTER_POLICY;
  if (normalized.environment && Object.keys(normalized.environment).length === 0) {
    delete normalized.environment;
  }
  return normalized;
};
if (
  hash(pick(base, topologyKeys)) !== hash(pick(g0, topologyKeys)) ||
  hash(pick(base, securityKeys)) !== hash(pick(g0, securityKeys)) ||
  hash(normalizeConfiguration(base)) !== hash(normalizeConfiguration(g0))
) {
  throw new Error("rendered G0 overlay changed protected OpenBot topology, security, or configuration");
}
EOF

printf '%s\n' "Rendered G0 overlay preserves reviewed OpenBot topology, security, and configuration."
