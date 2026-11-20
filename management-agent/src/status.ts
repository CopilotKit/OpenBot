/**
 * The heartbeat: the fixed list of fields the contract allows, read from the cluster. Versions,
 * digests, readiness counts, Flux's state, the last migration. Never a log line, a name, a secret
 * or anything a person wrote.
 */
import {
  lastMigrationName,
  type ReleaseIdentity,
  runningIdentity,
  serverDeployment,
} from "../../shared/kubernetes-promotion";
import type { Heartbeat, UpgradeState } from "../../shared/management-contract";
import type { AgentConfig } from "./config";
import { type Flux, ready } from "./flux";
import { type Kube, run } from "./kube";

export const AGENT_VERSION = process.env.OPENBOT_AGENT_VERSION ?? "0.1.0";

interface Workload {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { replicas?: number };
  status?: { readyReplicas?: number };
}
interface Pod {
  metadata: { name: string; labels?: Record<string, string> };
  status?: { containerStatuses?: { name: string; imageID?: string }[] };
}

const unknown = (value: string | undefined | null) =>
  value?.trim() ? value.trim().slice(0, 512) : "unknown";
const clip = (value: string | undefined, length: number) =>
  (value ?? "").slice(0, length);

export function productTarget(config: AgentConfig) {
  return {
    namespace: config.product.namespace,
    release: config.product.releaseName,
    cwd: "/tmp",
    timeoutSeconds: 600,
  };
}

/** The server's internal status Service, which answers /release to the agent's namespace without
 * pods/exec (the chart's `server.internalStatus`, which the agent's pins switch on). */
export function internalReleaseUrl(config: AgentConfig) {
  return `http://${config.product.releaseName}-server-internal.${config.product.namespace}.svc:9464/release`;
}

/** What the running server says on /release, or null when there is no server to ask. It asks the
 * internal status Service first, and from inside the server's container where a release has none. */
export async function readIdentity(
  config: AgentConfig,
): Promise<ReleaseIdentity | null> {
  try {
    const response = await fetch(internalReleaseUrl(config), {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return (await response.json()) as ReleaseIdentity;
  } catch {
    // No internal status Service on this release: read it from inside the container.
  }
  try {
    const target = productTarget(config);
    const deployment = await serverDeployment(target, run);
    if ((deployment.spec.replicas ?? 1) === 0) return null;
    return await runningIdentity(
      target,
      run,
      deployment.metadata?.name ?? `${target.release}-server`,
    );
  } catch {
    return null;
  }
}

export async function collectHeartbeat(options: {
  config: AgentConfig;
  kube: Kube;
  flux: Flux;
  upgrade: {
    state: UpgradeState;
    targetVersion: string | null;
    journal: string | null;
  };
  acceptedVersion: string | null;
}): Promise<Heartbeat> {
  const { config, kube, flux } = options;
  const namespace = config.product.namespace;
  const [deployments, statefulSets, pods, release, identity] =
    await Promise.all([
      kube.list<Workload>(namespace, "deployments").catch(() => []),
      kube.list<Workload>(namespace, "statefulsets").catch(() => []),
      kube.list<Pod>(namespace, "pods").catch(() => []),
      flux.helmRelease().catch(() => null),
      readIdentity(config),
    ]);
  const imageDigests: Record<string, string> = {};
  for (const pod of pods) {
    const workload =
      pod.metadata.labels?.["app.kubernetes.io/component"] ??
      pod.metadata.labels?.["app.kubernetes.io/name"] ??
      pod.metadata.name;
    for (const container of pod.status?.containerStatuses ?? []) {
      const digest = container.imageID?.match(/sha256:[0-9a-f]{64}/)?.[0];
      if (digest && Object.keys(imageDigests).length < 64)
        imageDigests[`${workload}/${container.name}`.slice(0, 253)] = digest;
    }
  }
  const intelligenceChart = deployments
    .map((deployment) => deployment.metadata.labels?.["helm.sh/chart"] ?? "")
    .find((chart) => chart.startsWith("intelligence-"));
  const condition = release ? ready(release) : undefined;
  const history = release?.status?.history?.[0];
  return {
    installId: config.installId,
    agentVersion: AGENT_VERSION,
    cloud: config.cloud,
    openbot: {
      version: unknown(identity?.version ?? options.acceptedVersion),
      chartVersion: unknown(history?.chartVersion),
      imageDigests,
    },
    intelligence: {
      chartVersion: intelligenceChart
        ? unknown(intelligenceChart.slice("intelligence-".length))
        : "none",
    },
    lastAppliedMigration: lastMigrationName(identity)
      ? clip(lastMigrationName(identity) ?? "", 512)
      : null,
    flux: {
      helmReleases: release
        ? [
            {
              name: release.metadata.name,
              ready: condition?.status === "True",
              reason: clip(condition?.reason, 512),
              message: clip(condition?.message, 2048),
              // The chart version and OCI digest of the last release Helm deployed. A history
              // entry's own `digest` is the Helm release's, not the chart's, so it is not used.
              lastAppliedRevision: clip(
                history?.status === "deployed" && history.chartVersion
                  ? `${history.chartVersion}${condition?.status === "True" && release.status?.lastAttemptedRevisionDigest ? `@${release.status.lastAttemptedRevisionDigest}` : ""}`
                  : "",
                512,
              ),
            },
          ]
        : [],
    },
    pods: [...deployments, ...statefulSets].slice(0, 64).map((workload) => ({
      workload: workload.metadata.name.slice(0, 512),
      ready: workload.status?.readyReplicas ?? 0,
      desired: workload.spec?.replicas ?? 0,
    })),
    upgrade: options.upgrade,
    sentAt: new Date().toISOString(),
  };
}
