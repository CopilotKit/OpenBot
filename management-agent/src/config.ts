/**
 * What the agent is told by the `openbot-agent` chart: a JSON file rendered from the chart's values
 * and mounted from a ConfigMap, the install's client certificate mounted from the customer's
 * Secret, and its own namespace from the downward API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CLOUDS, MaintenanceWindow } from "../../shared/management-contract";

const name = z
  .string()
  .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
  .max(63);

export const AgentConfig = z.strictObject({
  managementUrl: z.url({ protocol: /^https?$/ }),
  installId: z.uuid(),
  cloud: z.enum(CLOUDS),
  /** Base64 of the raw 32-byte Ed25519 key the management service signs commands with. */
  commandPublicKey: z.base64(),
  /** The customer's own weekly window. Upgrades run only inside it and inside the service's. */
  window: MaintenanceWindow.nullable(),
  agentNamespace: name,
  product: z.strictObject({
    chart: z.enum(["bundle", "openbot"]),
    releaseName: name,
    namespace: name,
    helmRelease: name,
    ociRepository: name,
    pinsConfigMap: name,
  }),
  backup: z.strictObject({
    kind: z.enum([
      "rds-snapshot",
      "aurora-snapshot",
      "azure-pg-backup",
      "cloudsql-backup",
      "alloydb-backup",
      "command",
    ]),
    timeoutSeconds: z.number().int().min(60).max(86_400),
  }),
  stateConfigMap: name,
  supportBundle: z.strictObject({ pvc: name }),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export interface Credentials {
  cert: string;
  key: string;
  ca?: string;
}

export interface Agent {
  config: AgentConfig;
  credentials: Credentials;
  /** Complete Job manifests with `__OPERATION__` where the operation's id goes. */
  jobs: { backup: string; supportBundle: string };
}

export const CONFIG_DIRECTORY = "/etc/openbot-agent";
export const TLS_DIRECTORY = "/var/run/openbot-agent/tls";

function optional(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function loadAgent(
  configDirectory = process.env.OPENBOT_AGENT_CONFIG ?? CONFIG_DIRECTORY,
  tlsDirectory = process.env.OPENBOT_AGENT_TLS ?? TLS_DIRECTORY,
): Agent {
  const raw = JSON.parse(
    readFileSync(join(configDirectory, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  if (process.env.AGENT_NAMESPACE)
    raw.agentNamespace = process.env.AGENT_NAMESPACE;
  const config = AgentConfig.parse(raw);
  return {
    config,
    credentials: {
      cert: readFileSync(join(tlsDirectory, "tls.crt"), "utf8"),
      key: readFileSync(join(tlsDirectory, "tls.key"), "utf8"),
      ca: optional(join(tlsDirectory, "ca.crt")),
    },
    jobs: {
      backup: readFileSync(join(configDirectory, "backup-job.yaml"), "utf8"),
      supportBundle: readFileSync(
        join(configDirectory, "support-bundle-job.yaml"),
        "utf8",
      ),
    },
  };
}
