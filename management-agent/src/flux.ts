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
    /** The last `reconcile.fluxcd.io/requestedAt` value helm-controller acted on. */
    lastHandledReconcileAt?: string;
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

  /**
   * Moves Flux to exactly `digest` and lets it install, then asks both controllers to act now.
   * Returns the request's token, which helm-controller reports back as `lastHandledReconcileAt`
   * once it has acted on it.
   *
   * When Flux last attempted this same digest and failed, the HelmRelease is also asked to reset
   * its failure counts (`resetAt`, with the same token as `requestedAt`, as `flux reconcile
   * helmrelease --reset` does). Remediation retries are 0, so after a failed install or upgrade
   * Flux tries the same chart and values again only on a reset: without it, putting back a digest
   * that already failed (a failed first install, once a person has fixed its cause) would leave
   * the release failed. https://fluxcd.io/flux/components/helm/helmreleases/#resetting-remediation-retries
   *
   * Only then. A new digest resets the counts by itself (the chart changed), and a reset sent with
   * it made helm-controller 1.7 run a failed upgrade a second time: right after the first attempt
   * failed, its next pass still saw the reset as unhandled, cleared the failure and upgraded again
   * (seen on EKS: two failed Helm revisions of the same chart, ten more minutes with the server
   * stopped and the release's hooks run again, and the agent waiting out its own timeout).
   */
  async pin(digest: string) {
    const before = await this.helmRelease();
    const failedOnThisDigest =
      before?.status?.lastAttemptedRevisionDigest === digest &&
      ready(before)?.status === "False";
    await this.kube.patch(
      this.namespace,
      "ocirepositories.source.toolkit.fluxcd.io",
      this.config.product.ociRepository,
      { spec: { ref: { digest }, suspend: false } },
    );
    await this.setHelmReleaseSuspended(false);
    const token = new Date().toISOString();
    await this.kube.annotate(
      this.namespace,
      "ocirepositories.source.toolkit.fluxcd.io",
      this.config.product.ociRepository,
      `reconcile.fluxcd.io/requestedAt=${token}`,
    );
    // Both in one change, so helm-controller never sees the request without the reset.
    await this.kube.annotate(
      this.namespace,
      "helmreleases.helm.toolkit.fluxcd.io",
      this.config.product.helmRelease,
      `reconcile.fluxcd.io/requestedAt=${token}`,
      ...(failedOnThisDigest ? [`reconcile.fluxcd.io/resetAt=${token}`] : []),
    );
    return token;
  }

  /**
   * Waits until the HelmRelease has attempted `digest` and says whether that worked. Flux's
   * remediation is off, so a failed install or upgrade stays failed for a person to look at.
   *
   * With the token `pin` returned, only a status written after helm-controller acted on that
   * request counts: a digest put back after it failed shows the old failure until then.
   */
  async waitForRelease(digest: string, timeoutSeconds: number, token?: string) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last = "";
    while (Date.now() < deadline) {
      const release = await this.helmRelease();
      const condition = release ? ready(release) : undefined;
      const attempted =
        release?.status?.lastAttemptedRevisionDigest === digest ||
        release?.status?.lastAttemptedRevision?.endsWith(digest);
      const current =
        release?.status?.observedGeneration === release?.metadata.generation &&
        (token === undefined ||
          release?.status?.lastHandledReconcileAt === token);
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
