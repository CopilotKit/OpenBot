/**
 * What the agent is told by the `openbot-agent` chart: a JSON file rendered from the chart's values
 * and mounted from a ConfigMap, the install's client certificate mounted from the customer's
 * Secret (or, with `enrollment`, read from the agent's own Secret once it has enrolled: enroll.ts),
 * and its own namespace from the downward API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CLOUDS,
  HEARTBEAT_INTERVAL_SECONDS,
  MaintenanceWindow,
} from "../../shared/management-contract";

const name = z
  .string()
  .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
  .max(63);

/** Self-serve enrollment (enroll.ts): how an agent with no certificate yet gets one. */
export const EnrollmentConfig = z.strictObject({
  /** OpenBot's internal status port, where the agent collects the enrollment token. */
  serverUrl: z.url({ protocol: /^https?$/ }),
  /** CopilotKit's enrollment API. */
  url: z.url({ protocol: /^https?$/ }),
  /** The agent's own Secret in its namespace: tls.crt and tls.key once enrolled. */
  credentialsSecret: name,
  /** The projected service account token the agent proves itself to OpenBot with. */
  tokenFile: z.string().startsWith("/"),
  /** PEM of a private CA the services' own certificates are checked against. Only for a test
   * management service; null trusts the public authorities. */
  trustCa: z.string().includes("-----BEGIN CERTIFICATE-----").nullable(),
});
export type EnrollmentConfig = z.infer<typeof EnrollmentConfig>;

export const AgentConfig = z
  .strictObject({
    managementUrl: z.url({ protocol: /^https?$/ }),
    /**
     * Whether the agent runs the product's upgrades, with Flux beside it (the `openbot-agent` release).
     * false: the agent the product chart installs by default, connected and reporting, running restart
     * and support-bundle commands, with no Flux and no upgrades, until a person sets upgrades up.
     * Absent: true, as every agent before this setting ran.
     */
    managedUpgrades: z.boolean().optional(),
    /** null only with `enrollment`: the id then comes from the certificate the agent enrolls for. */
    installId: z.uuid().nullable(),
    /** Absent or null: the certificate is mounted from the customer's Secret, as before enrollment. */
    enrollment: EnrollmentConfig.nullable().optional(),
    cloud: z.enum(CLOUDS),
    /** Base64 of the raw 32-byte Ed25519 key the management service signs commands with. */
    commandPublicKey: z.base64(),
    /** The customer's own weekly window. Upgrades run only inside it and inside the service's. */
    window: MaintenanceWindow.nullable(),
    agentNamespace: name,
    /** Seconds between heartbeats, before jitter. Absent: HEARTBEAT_INTERVAL_SECONDS (60). A test
     * cluster sets a few seconds so each step it waits on comes round sooner. */
    heartbeatIntervalSeconds: z.number().int().min(1).max(3600).optional(),
    product: z.strictObject({
      chart: z.enum(["bundle", "openbot"]),
      releaseName: name,
      namespace: name,
      helmRelease: name,
      ociRepository: name,
      pinsConfigMap: name,
      /** Where Flux pulls the product's chart from: the OCIRepository the agent creates. */
      source: z.strictObject({
        url: z.string().regex(/^oci:\/\/\S+$/),
        /** The first pin. null waits, suspended, for the management service to name a version. */
        digest: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/)
          .nullable(),
        insecure: z.boolean(),
        pullSecret: name.nullable(),
        /**
         * How Flux signs in to the registry: `aws`, `azure` or `gcp` with source-controller's own
         * workload identity, for a mirror in the cloud's registry (ECR, ACR, Artifact Registry),
         * whose short-lived tokens a pull secret can't hold. Absent: `pullSecret`, or none.
         */
        provider: z.enum(["aws", "azure", "gcp"]).optional(),
        verify: z
          .strictObject({
            provider: z.enum(["cosign", "notation"]),
            secretRef: name,
          })
          .nullable(),
      }),
      /** How Flux installs it: the HelmRelease the agent creates. */
      release: z.strictObject({
        serviceAccountName: name,
        timeout: z.string().regex(/^([0-9]+(\.[0-9]+)?(ms|s|m|h))+$/),
        valuesFrom: z.array(
          z.strictObject({
            kind: z.enum(["Secret", "ConfigMap"]),
            name,
            valuesKey: z.string().optional(),
            targetPath: z.string().optional(),
            optional: z.boolean().optional(),
          }),
        ),
      }),
    }),
    backup: z.strictObject({
      kind: z.enum([
        "rds-snapshot",
        "aurora-snapshot",
        "azure-pg-backup",
        "cloudsql-backup",
        "alloydb-backup",
        "command",
        // No backup chosen yet: every upgrade that migrates the database is refused before
        // anything is touched, until a person sets one (backup-target.ts).
        "none",
      ]),
      timeoutSeconds: z.number().int().min(60).max(86_400),
    }),
    stateConfigMap: name,
    supportBundle: z.strictObject({ pvc: name }),
  })
  .refine((config) => config.installId !== null || config.enrollment, {
    message: "installId is required unless enrollment is set",
    path: ["installId"],
  });
export type AgentConfig = z.infer<typeof AgentConfig>;

/** Whether the agent runs upgrades (see `managedUpgrades`). */
export const upgradesOn = (config: Pick<AgentConfig, "managedUpgrades">) =>
  config.managedUpgrades !== false;

export interface Credentials {
  cert: string;
  key: string;
  ca?: string;
}

export interface Agent {
  config: AgentConfig;
  /** null until an agent with `enrollment` has enrolled (enroll.ts `enrolledAgent`). */
  credentials: Credentials | null;
  /** Complete Job manifests with `__OPERATION__` where the operation's id goes. `backupTarget`
   * asks the cloud where the configured backup target answers (backup-target.ts); a chart from
   * before the backup target guard has none, and every cloud-kind backup is then refused. */
  jobs: { backup: string; backupTarget?: string; supportBundle: string };
}

/** The agent once it has its install id and certificate: what the heartbeat loop runs with. */
export type ReadyAgent = Omit<Agent, "config" | "credentials"> & {
  config: AgentConfig & { installId: string };
  credentials: Credentials;
};

/** How long the agent waits between heartbeats, before jitter. */
export function heartbeatIntervalMs(config: AgentConfig) {
  return (config.heartbeatIntervalSeconds ?? HEARTBEAT_INTERVAL_SECONDS) * 1000;
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
    // With enrollment the certificate is in the agent's own Secret, read through the API.
    credentials: config.enrollment
      ? null
      : {
          cert: readFileSync(join(tlsDirectory, "tls.crt"), "utf8"),
          key: readFileSync(join(tlsDirectory, "tls.key"), "utf8"),
          ca: optional(join(tlsDirectory, "ca.crt")),
        },
    jobs: {
      backup: readFileSync(join(configDirectory, "backup-job.yaml"), "utf8"),
      backupTarget: optional(join(configDirectory, "backup-target-job.yaml")),
      supportBundle: readFileSync(
        join(configDirectory, "support-bundle-job.yaml"),
        "utf8",
      ),
    },
  };
}
