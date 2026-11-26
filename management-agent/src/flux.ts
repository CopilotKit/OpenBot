/**
 * The two Flux objects that install the product, which the agent creates and steers: the
 * OCIRepository, pinned to an exact chart digest (never a tag or a range), and the HelmRelease that
 * installs from it with Flux's automatic remediation off.
 *
 * THE AGENT CREATES THEM, NOT THE CHART. Helm 4's `--wait` waits for every object in a release to
 * report ready, and these report the product's state, not the agent's: a suspended OCIRepository
 * that has never been reconciled keeps the observedGeneration -1 its CRD defaults to, and a failed
 * product install leaves the HelmRelease Stalled. In the chart's release either one failed
 * `helm install --wait` and `helm upgrade --wait` of the agent chart (the pause among them, whose
 * hook then never ran). So the chart hands the agent their settings and the agent applies them.
 *
 * On every heartbeat the agent creates a missing object (suspended on a placeholder digest until the
 * management service names a version, unless the chart gave a first pin) and brings an existing one
 * to the chart's settings. It never changes an existing object's `spec.ref.digest` or
 * `spec.suspend` there: those move only by a pin, a pause or a person.
 */
import type { AgentConfig } from "./config";
import type { Kube } from "./kube";

const OCI_REPOSITORY = "ocirepositories.source.toolkit.fluxcd.io";
const HELM_RELEASE = "helmreleases.helm.toolkit.fluxcd.io";

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
  metadata: { name: string; generation?: number };
  spec: { suspend?: boolean; ref?: { digest?: string } };
  status?: {
    artifact?: { revision?: string; digest?: string };
    conditions?: Condition[];
    /** The last `reconcile.fluxcd.io/requestedAt` value source-controller acted on. */
    lastHandledReconcileAt?: string;
  };
}

export function ready(object: { status?: { conditions?: Condition[] } }) {
  return object.status?.conditions?.find(
    (condition) => condition.type === "Ready",
  );
}

/** Flux's verdict on the chart's signature, when the OCIRepository checks one. */
function signatureCondition(object: { status?: { conditions?: Condition[] } }) {
  return object.status?.conditions?.find(
    (condition) => condition.type === "SourceVerified",
  );
}

/** Flux refused the chart because its signature does not verify with the keys it was given. */
function refusedForSignature(object: OCIRepository) {
  const conditions = [ready(object), signatureCondition(object)];
  return conditions.find(
    (condition) =>
      condition?.status === "False" && condition.reason === "VerificationError",
  );
}

/**
 * A chart whose signature Flux does not verify with the keys the chart gave it: unsigned, or signed
 * with another key. Nothing was touched for it.
 */
export class ChartRefused extends Error {
  constructor(
    readonly digest: string,
    readonly reason: string,
  ) {
    super(
      `the chart ${digest} is refused: its signature does not verify with this install's chart key (${reason})`,
    );
  }
}

/** How long Flux is given to pull a chart and check its signature. */
export const SIGNATURE_CHECK_SECONDS = 300;

/** Labels on both objects. The agent owns them; Helm's release annotations, left by a chart that
 * once rendered them, are taken off. */
const OWNED_METADATA = {
  labels: {
    "app.kubernetes.io/part-of": "openbot-agent",
    "app.kubernetes.io/managed-by": "openbot-agent",
  },
  annotations: {
    "meta.helm.sh/release-name": null,
    "meta.helm.sh/release-namespace": null,
  },
};

/** The OCIRepository's settings from the chart, without `ref` and `suspend`. A null removes the
 * field from an existing object (a JSON merge patch) and is left out of a new one. */
export function sourceSettings(config: AgentConfig) {
  const source = config.product.source;
  return {
    interval: "10m",
    url: source.url,
    // The chart archive as published, not unpacked.
    layerSelector: {
      mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip",
      operation: "copy",
    },
    insecure: source.insecure ? true : null,
    secretRef: source.pullSecret ? { name: source.pullSecret } : null,
    // The cloud's registry, signed in to with source-controller's workload identity.
    provider: source.provider ?? null,
    // Flux checks the chart's signature before Helm reads it.
    verify: source.verify
      ? {
          provider: source.verify.provider,
          secretRef: { name: source.verify.secretRef },
        }
      : null,
  };
}

/** The HelmRelease's settings from the chart, without `suspend`. */
export function releaseSettings(config: AgentConfig) {
  const { product } = config;
  const remediation = { retries: 0, remediateLastFailure: false };
  return {
    interval: "10m",
    chartRef: {
      kind: "OCIRepository",
      name: product.ociRepository,
      namespace: config.agentNamespace,
    },
    // The release runs AND is stored in the product's namespace, so plain `helm -n <namespace>`
    // sees the same release Flux manages (off level 2).
    releaseName: product.releaseName,
    targetNamespace: product.namespace,
    storageNamespace: product.namespace,
    // Impersonated for every Helm action: admin in the product namespace, nothing else.
    serviceAccountName: product.release.serviceAccountName,
    timeout: product.release.timeout,
    // NO AUTOMATIC REMEDIATION: a failed install or upgrade stays failed, for the agent to journal
    // as recovery-required and a person to clear. CLIENT-SIDE APPLY, as plain Helm does: under
    // server-side apply helm-controller owns every field, and after a disconnect a plain
    // `helm upgrade` stops on "conflicts with helm-controller".
    install: { serverSideApply: false, remediation },
    upgrade: { serverSideApply: "disabled", remediation },
    // The cluster is not corrected towards the chart between upgrades.
    driftDetection: { mode: "disabled" },
    // In the chart's order: the customer's sources, the product values management needs, then the
    // agent's pins last, so they win.
    valuesFrom: product.release.valuesFrom,
  };
}

function withoutNulls(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null),
  );
}

/**
 * The product's two Flux objects as the agent keeps them: for each, its settings (what an existing
 * object is brought to) and the whole object a missing one is created as. A new pair starts on the
 * chart's first pin, or suspended on the placeholder until the management service names a version.
 * The source first, because the release names it.
 */
export function productObjects(config: AgentConfig) {
  const { product, agentNamespace } = config;
  const pin = product.source.digest;
  const objects = [
    {
      resource: OCI_REPOSITORY,
      apiVersion: "source.toolkit.fluxcd.io/v1",
      kind: "OCIRepository",
      name: product.ociRepository,
      settings: sourceSettings(config) as Record<string, unknown>,
      first: { ref: { digest: pin ?? PLACEHOLDER_DIGEST }, suspend: !pin },
    },
    {
      resource: HELM_RELEASE,
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      name: product.helmRelease,
      settings: releaseSettings(config) as Record<string, unknown>,
      first: { suspend: !pin },
    },
  ];
  return objects.map((object) => ({
    resource: object.resource,
    name: object.name,
    settings: object.settings,
    manifest: {
      apiVersion: object.apiVersion,
      kind: object.kind,
      metadata: {
        name: object.name,
        namespace: agentNamespace,
        labels: OWNED_METADATA.labels,
      },
      spec: { ...withoutNulls(object.settings), ...object.first },
    },
  }));
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
      HELM_RELEASE,
      this.config.product.helmRelease,
    );
  }

  ociRepository() {
    return this.kube.get<OCIRepository>(
      this.namespace,
      OCI_REPOSITORY,
      this.config.product.ociRepository,
    );
  }

  async pinnedDigest() {
    const repository = await this.ociRepository();
    const digest = repository?.spec.ref?.digest;
    return digest && digest !== PLACEHOLDER_DIGEST ? digest : null;
  }

  /** The OCIRepository the agent has Flux check a chart's signature with, beside the product's. */
  get signatureCheckName() {
    return `${this.config.product.ociRepository}-signature-check`;
  }

  /**
   * Has Flux check `digest`'s signature BEFORE anything is touched for it: no quiescing, no backup,
   * no pin. Flux's own verifier, with the chart's keys, registry and sign-in, on an OCIRepository of
   * its own (the product's stays where it is): the same check the product's source makes when it is
   * pinned, made first. Throws `ChartRefused` for a chart that is unsigned or signed with another
   * key, and an error when Flux does not finish the check in time. Returns at once when the chart
   * turns verification off (`verify: null`).
   *
   * The check object is suspended once it has answered, so it pulls nothing between upgrades.
   */
  async checkSignature(
    digest: string,
    timeoutSeconds = SIGNATURE_CHECK_SECONDS,
  ) {
    const settings = sourceSettings(this.config);
    if (!settings.verify) return;
    const name = this.signatureCheckName;
    const spec = { ...settings, ref: { digest }, suspend: false };
    const live = await this.kube.get<OCIRepository>(
      this.namespace,
      OCI_REPOSITORY,
      name,
    );
    if (live)
      await this.kube.patch(this.namespace, OCI_REPOSITORY, name, {
        metadata: OWNED_METADATA,
        spec,
      });
    else
      await this.kube.create(
        JSON.stringify({
          apiVersion: "source.toolkit.fluxcd.io/v1",
          kind: "OCIRepository",
          metadata: {
            name,
            namespace: this.namespace,
            labels: OWNED_METADATA.labels,
          },
          spec: withoutNulls(spec),
        }),
      );
    const token = new Date().toISOString();
    await this.kube.annotate(
      this.namespace,
      OCI_REPOSITORY,
      name,
      `reconcile.fluxcd.io/requestedAt=${token}`,
    );
    try {
      const deadline = Date.now() + timeoutSeconds * 1000;
      let last = "not checked yet";
      while (Date.now() < deadline) {
        const source = await this.kube.get<OCIRepository>(
          this.namespace,
          OCI_REPOSITORY,
          name,
        );
        const condition = source ? ready(source) : undefined;
        // Only an answer to this request about this spec counts: Ready's own observedGeneration
        // (Flux moves status.observedGeneration only on success) and the token it last handled.
        const current =
          source !== null &&
          condition !== undefined &&
          condition.observedGeneration === source.metadata.generation &&
          source.status?.lastHandledReconcileAt === token;
        if (source && condition)
          last = `${condition.reason ?? ""}: ${condition.message ?? ""}`;
        if (current && source) {
          const refused = refusedForSignature(source);
          if (refused)
            throw new ChartRefused(
              digest,
              refused.message ?? refused.reason ?? "",
            );
          if (
            condition.status === "True" &&
            signatureCondition(source)?.status === "True" &&
            source.status?.artifact?.revision?.includes(digest)
          )
            return;
        }
        await Bun.sleep(2_000);
      }
      throw new Error(
        `Flux did not finish checking the signature of the chart ${digest} in time: ${last}`,
      );
    } finally {
      await this.kube
        .patch(this.namespace, OCI_REPOSITORY, name, {
          spec: { suspend: true },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Creates whichever of the two objects is missing and brings an existing one to the chart's
   * settings, leaving its digest and suspension as they are. Returns the kinds it created.
   */
  async ensure() {
    const created: string[] = [];
    for (const object of productObjects(this.config)) {
      const live = await this.kube.get<{ spec?: unknown }>(
        this.namespace,
        object.resource,
        object.name,
      );
      if (live) {
        await this.kube.patch(this.namespace, object.resource, object.name, {
          metadata: OWNED_METADATA,
          spec: object.settings,
        });
        continue;
      }
      await this.kube.create(JSON.stringify(object.manifest));
      created.push(object.manifest.kind);
    }
    return created;
  }

  setHelmReleaseSuspended(suspend: boolean) {
    return this.kube.patch(
      this.namespace,
      HELM_RELEASE,
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
      OCI_REPOSITORY,
      this.config.product.ociRepository,
      { spec: { ref: { digest }, suspend: false } },
    );
    await this.setHelmReleaseSuspended(false);
    const token = new Date().toISOString();
    await this.kube.annotate(
      this.namespace,
      OCI_REPOSITORY,
      this.config.product.ociRepository,
      `reconcile.fluxcd.io/requestedAt=${token}`,
    );
    // Both in one change, so helm-controller never sees the request without the reset.
    await this.kube.annotate(
      this.namespace,
      HELM_RELEASE,
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
      // The product's source refused the chart's signature (its key changed after the check, say):
      // Helm never reads it, so there is nothing to wait for.
      const source = await this.ociRepository().catch(() => null);
      const refused =
        source?.spec.ref?.digest === digest
          ? refusedForSignature(source)
          : undefined;
      if (refused)
        throw new ChartRefused(digest, refused.message ?? refused.reason ?? "");
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
