/**
 * The two Flux objects the chart renders for the product and the agent steers: the OCIRepository,
 * pinned to an exact chart digest (never a tag or a range), and the HelmRelease that installs from
 * it with Flux's automatic remediation off. The agent changes only the OCIRepository's
 * `spec.ref.digest`, both objects' `spec.suspend`, and its pins ConfigMap.
 */
import type { AgentConfig } from "./config";
import type { Kube } from "./kube";

/** The digest the chart renders before any version is known; the objects stay suspended on it. */
export const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  observedGeneration?: number;
}
export interface HelmRelease {
  metadata: { name: string; generation?: number };
  spec: { suspend?: boolean };
  status?: {
    observedGeneration?: number;
    conditions?: Condition[];
    lastAttemptedRevision?: string;
    lastAttemptedRevisionDigest?: string;
    history?: {
      chartName?: string;
      chartVersion?: string;
      appVersion?: string;
      digest?: string;
      status?: string;
    }[];
  };
}
export interface OCIRepository {
  metadata: { name: string };
  spec: { suspend?: boolean; ref?: { digest?: string } };
  status?: {
    artifact?: { revision?: string; digest?: string };
    conditions?: Condition[];
  };
}

export function ready(object: { status?: { conditions?: Condition[] } }) {
  return object.status?.conditions?.find(
    (condition) => condition.type === "Ready",
  );
}

export class Flux {
  constructor(
    private readonly kube: Kube,
    private readonly config: AgentConfig,
  ) {}

  private get namespace() {
    return this.config.agentNamespace;
  }

  helmRelease() {
    return this.kube.get<HelmRelease>(
      this.namespace,
      "helmreleases.helm.toolkit.fluxcd.io",
      this.config.product.helmRelease,
    );
  }

  ociRepository() {
    return this.kube.get<OCIRepository>(
      this.namespace,
      "ocirepositories.source.toolkit.fluxcd.io",
      this.config.product.ociRepository,
    );
  }

  async pinnedDigest() {
    const repository = await this.ociRepository();
    const digest = repository?.spec.ref?.digest;
    return digest && digest !== PLACEHOLDER_DIGEST ? digest : null;
  }

  setHelmReleaseSuspended(suspend: boolean) {
    return this.kube.patch(
      this.namespace,
      "helmreleases.helm.toolkit.fluxcd.io",
      this.config.product.helmRelease,
      { spec: { suspend } },
    );
  }

  /** Writes the values the agent pins on top of the customer's: the image by digest and the
   * release's identity. The HelmRelease reads them last, so they win. */
  writePins(values: Record<string, unknown>) {
    const nested =
      this.config.product.chart === "bundle" ? { openbot: values } : values;
    return this.kube.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: this.config.product.pinsConfigMap,
        namespace: this.namespace,
        labels: { "app.kubernetes.io/part-of": "openbot-agent" },
      },
      data: { "values.yaml": `${JSON.stringify(nested, null, 2)}\n` },
    });
  }

  /** Moves Flux to exactly `digest` and lets it install, then asks both controllers to act now. */
  async pin(digest: string) {
    await this.kube.patch(
      this.namespace,
      "ocirepositories.source.toolkit.fluxcd.io",
      this.config.product.ociRepository,
      { spec: { ref: { digest }, suspend: false } },
    );
    await this.setHelmReleaseSuspended(false);
    const now = new Date().toISOString();
    for (const resource of [
      "ocirepositories.source.toolkit.fluxcd.io/" +
        this.config.product.ociRepository,
      `helmreleases.helm.toolkit.fluxcd.io/${this.config.product.helmRelease}`,
    ]) {
      const [kind = "", name = ""] = resource.split("/");
      await this.kube.annotate(
        this.namespace,
        kind,
        name,
        `reconcile.fluxcd.io/requestedAt=${now}`,
      );
    }
  }

  /**
   * Waits until the HelmRelease has attempted `digest` and says whether that worked. Flux's
   * remediation is off, so a failed install or upgrade stays failed for a person to look at.
   */
  async waitForRelease(digest: string, timeoutSeconds: number) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last = "";
    while (Date.now() < deadline) {
      const release = await this.helmRelease();
      const condition = release ? ready(release) : undefined;
      const attempted =
        release?.status?.lastAttemptedRevisionDigest === digest ||
        release?.status?.lastAttemptedRevision?.endsWith(digest);
      const current =
        release?.status?.observedGeneration === release?.metadata.generation;
      last = condition
        ? `${condition.reason ?? ""}: ${condition.message ?? ""}`
        : "no Ready condition yet";
      if (attempted && current && condition?.status === "True") return;
      if (
        attempted &&
        current &&
        condition?.status === "False" &&
        /Failed|Stalled/.test(condition.reason ?? "")
      )
        throw new Error(`Flux could not apply the release: ${last}`);
      await Bun.sleep(5_000);
    }
    throw new Error(`Flux did not apply the release in time: ${last}`);
  }
}
