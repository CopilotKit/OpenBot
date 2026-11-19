/**
 * After a promotion stops in `recovery-required`, a person restores the backup, sets the desired
 * version back to the release that ran on that data (the accepted one) and removes journal.json.
 * Flux is still pinned to the failed release's chart and the pins still name its image, so the agent
 * has to put the accepted release back itself, inside the maintenance window, without a backup.
 *
 * The cluster here is a fake kubectl over in-memory objects. It answers the commands the agent runs
 * the way the API server does (NotFound, merge patches that bump `metadata.generation` only when the
 * spec changes, server-side apply of whole ConfigMaps), and plays Flux's helm-controller when the
 * agent asks it to reconcile: it renders the server Deployment from the pinned chart and the pins
 * ConfigMap, and reports the attempt on the HelmRelease. An image that does not exist never becomes
 * ready, so neither its rollout nor its /release answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import published from "../../shared/fixtures/releases/published-v1.1.0.json";
import type { PromotionJournal } from "../../shared/kubernetes-promotion";
import {
  type Heartbeat,
  type HeartbeatReply,
  type MaintenanceWindow,
  releaseManifestDigest,
} from "../../shared/management-contract";
import { ManagementAgent } from "../src/agent";
import type { ManagementClient } from "../src/client";
import type { Agent } from "../src/config";
import { CommandFailed, Kube } from "../src/kube";
import { internalReleaseUrl } from "../src/status";

const SYSTEM = "openbot-system";
const PRODUCT = "openbot";
const ACCEPTED_CHART = `sha256:${"a".repeat(64)}`;
const FAILED_CHART = `sha256:${"f".repeat(64)}`;
const FAILED_IMAGE = `sha256:${"e".repeat(64)}`;
const ACCEPTED_IMAGE = published.artifacts.images.openbot.reference.split(
  "@",
)[1] as string;
const MANIFEST = JSON.stringify(published);

const agent: Agent = {
  config: {
    managementUrl: "https://management.example.test",
    installId: "0b7f4f2e-3a49-4f61-9d2c-6c1d5a7e8f90",
    cloud: "other",
    commandPublicKey: Buffer.alloc(32).toString("base64"),
    window: null,
    agentNamespace: SYSTEM,
    product: {
      chart: "bundle",
      releaseName: "openbot",
      namespace: PRODUCT,
      helmRelease: "openbot",
      ociRepository: "openbot",
      pinsConfigMap: "openbot-agent-pins",
    },
    backup: { kind: "command", timeoutSeconds: 900 },
    stateConfigMap: "openbot-agent-state",
    supportBundle: { pvc: "openbot-support-bundles" },
  },
  credentials: { cert: "", key: "" },
  jobs: { backup: "", supportBundle: "" },
};

// A Tuesday afternoon, inside a Tuesday window and outside a Thursday one.
const NOW = new Date("2026-11-17T15:00:00Z");
const INSIDE: MaintenanceWindow = { weekday: 2, startUtc: "14:00", hours: 4 };
const OUTSIDE: MaintenanceWindow = { weekday: 4, startUtc: "14:00", hours: 4 };

// Kubernetes objects of any kind, read and changed the way kubectl does: untyped JSON.
// biome-ignore lint/suspicious/noExplicitAny: the fake handles every kind the agent touches
type Json = Record<string, any>;

const RESOURCES: Record<string, string> = {
  configmap: "ConfigMap",
  deployment: "Deployment",
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  pods: "Pod",
  cronjob: "CronJob",
  "helmreleases.helm.toolkit.fluxcd.io": "HelmRelease",
  "ocirepositories.source.toolkit.fluxcd.io": "OCIRepository",
};

function mergePatch(target: Json, patch: Json) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (typeof value === "object" && !Array.isArray(value)) {
      if (typeof target[key] !== "object" || target[key] === null)
        target[key] = {};
      mergePatch(target[key], value);
    } else target[key] = value;
  }
}

function matches(object: Json, selector: string | undefined) {
  if (!selector) return true;
  return selector.split(",").every((term) => {
    const [key = "", value] = term.split("=");
    return object.metadata?.labels?.[key] === value;
  });
}

/** The pinned values for one release, as the agent writes them. */
function pinsFor(version: string, imageDigest: string, commit: string) {
  const annotations = {
    "openbot.ai/distribution": "CopilotKit/OpenBot",
    "openbot.ai/release": version,
    "openbot.ai/source-commit": commit,
  };
  return {
    openbot: {
      image: {
        repository: "ghcr.io/copilotkit/openbot",
        tag: version,
        digest: imageDigest,
      },
      commonAnnotations: annotations,
      server: { podAnnotations: annotations },
    },
  };
}

class FakeCluster {
  readonly objects = new Map<string, Json>();
  /** Every command that changed something, in order. */
  readonly mutations: string[] = [];
  /** Chart digest to chart version: what the registry holds. */
  readonly charts = new Map([
    [ACCEPTED_CHART, "1.1.0"],
    [FAILED_CHART, "1.1.1"],
  ]);
  /** Image digest to what the server in it answers on /release. Only images that exist. */
  readonly images = new Map([
    [
      ACCEPTED_IMAGE,
      {
        version: "v1.1.0",
        distributionId: "CopilotKit/OpenBot",
        repository: "CopilotKit/OpenBot",
        channel: "stable",
      },
    ],
  ]);
  /** Runs before each change, so a test can hold the agent part-way through. */
  beforeChange: (what: string) => Promise<void> = async () => {};

  readonly kube = new Kube((command, options) => this.exec(command, options));

  private key(kind: string, namespace: string, name: string) {
    return `${kind}/${namespace}/${name}`;
  }

  put(object: Json) {
    this.objects.set(
      this.key(object.kind, object.metadata.namespace, object.metadata.name),
      object,
    );
  }

  object(kind: string, namespace: string, name: string) {
    const found = this.objects.get(this.key(kind, namespace, name));
    if (!found) throw new Error(`no ${kind} ${namespace}/${name}`);
    return found;
  }

  get pinnedDigest() {
    return this.object("OCIRepository", SYSTEM, "openbot").spec.ref.digest;
  }
  get pins() {
    return JSON.parse(
      this.object("ConfigMap", SYSTEM, "openbot-agent-pins").data[
        "values.yaml"
      ],
    );
  }
  get serverImage() {
    return this.object("Deployment", PRODUCT, "openbot-server").spec.template
      .spec.containers[0].image as string;
  }
  get agentState() {
    const data = this.object("ConfigMap", SYSTEM, "openbot-agent-state").data;
    return {
      state: JSON.parse(data["state.json"]),
      journal: data["journal.json"]
        ? (JSON.parse(data["journal.json"]) as PromotionJournal)
        : null,
    };
  }

  /** What the server in the running image answers on /release, if it runs. */
  identity() {
    const digest = this.serverImage.split("@")[1] ?? "";
    return this.images.get(digest) ?? null;
  }

  private kindOf(command: readonly string[], resource: string) {
    const kind = RESOURCES[resource];
    if (!kind)
      throw new Error(`the fake cluster has no ${resource}: ${command}`);
    return kind;
  }

  private async exec(
    command: readonly string[],
    options: { input?: string } = {},
  ): Promise<string> {
    if (command[0] !== "kubectl") throw new Error(`not kubectl: ${command}`);
    let args = command.slice(1);
    let namespace = "default";
    if (args[0] === "--namespace") {
      namespace = args[1] ?? "";
      args = args.slice(2);
    }
    const flag = (name: string) => {
      const at = args.indexOf(name);
      return at === -1 ? undefined : args[at + 1];
    };
    const [verb, resource = "", name = ""] = args;
    switch (verb) {
      case "get": {
        const kind = this.kindOf(command, resource);
        if (name && !name.startsWith("--")) {
          const found = this.objects.get(this.key(kind, namespace, name));
          if (!found)
            throw new CommandFailed(
              command,
              1,
              `Error from server (NotFound): ${resource} "${name}" not found`,
            );
          return JSON.stringify(found);
        }
        const selector = flag("--selector");
        const items = [...this.objects.values()].filter(
          (object) =>
            object.kind === kind &&
            object.metadata.namespace === namespace &&
            matches(object, selector),
        );
        return JSON.stringify({ items });
      }
      case "patch": {
        const kind = this.kindOf(command, resource);
        await this.beforeChange(`patch ${kind}/${name}`);
        const object = this.object(kind, namespace, name);
        const spec = JSON.stringify(object.spec);
        mergePatch(object, JSON.parse(flag("--patch") ?? "{}"));
        if (JSON.stringify(object.spec) !== spec)
          object.metadata.generation = (object.metadata.generation ?? 1) + 1;
        this.mutations.push(`patch ${kind}/${name} ${flag("--patch")}`);
        if (kind === "HelmRelease" && JSON.stringify(object.spec) !== spec)
          this.helmController();
        return "";
      }
      case "apply": {
        const manifest = JSON.parse(options.input ?? "{}") as Json;
        const { kind } = manifest;
        const { name: applied, namespace: where } = manifest.metadata;
        await this.beforeChange(`apply ${kind}/${applied}`);
        const existing = this.objects.get(this.key(kind, where, applied));
        this.put({
          ...manifest,
          metadata: { ...existing?.metadata, ...manifest.metadata },
        });
        this.mutations.push(`apply ${kind}/${applied}`);
        return "";
      }
      case "annotate": {
        const [, , target = "", objectName = "", value = ""] = args;
        const kind = this.kindOf(command, target);
        await this.beforeChange(`annotate ${kind}/${objectName}`);
        const object = this.object(kind, namespace, objectName);
        const [key = "", annotation = ""] = value.split("=");
        object.metadata.annotations = {
          ...object.metadata.annotations,
          [key]: annotation,
        };
        this.mutations.push(`annotate ${kind}/${objectName} ${key}`);
        if (kind === "HelmRelease" && key === "reconcile.fluxcd.io/requestedAt")
          this.helmController();
        return "";
      }
      case "rollout":
        if (resource === "status") {
          if (this.identity())
            return 'deployment "openbot-server" successfully rolled out\n';
          throw new CommandFailed(
            command,
            1,
            "error: timed out waiting for the condition",
          );
        }
        break;
      case "exec": {
        const identity = this.identity();
        if (identity) return JSON.stringify(identity);
        throw new CommandFailed(command, 1, "container not running");
      }
    }
    this.mutations.push(`unexpected ${args.join(" ")}`);
    throw new Error(`the fake cluster does not run: ${command.join(" ")}`);
  }

  /** Flux's helm-controller, on a reconcile request: install the pinned chart with the pins. */
  helmController() {
    const release = this.object("HelmRelease", SYSTEM, "openbot");
    const repository = this.object("OCIRepository", SYSTEM, "openbot");
    if (release.spec.suspend || repository.spec.suspend) return;
    const digest = repository.spec.ref.digest as string;
    const version = this.charts.get(digest);
    if (!version) throw new Error(`no chart ${digest} in the registry`);
    const values = this.pins.openbot;
    const server = this.object("Deployment", PRODUCT, "openbot-server");
    server.spec.template.spec.containers[0].image = `${values.image.repository}:${values.image.tag}@${values.image.digest}`;
    server.spec.template.metadata.annotations = {
      ...values.server.podAnnotations,
    };
    const runs = this.images.has(values.image.digest);
    server.status = { readyReplicas: runs ? 1 : 0 };
    release.status = {
      observedGeneration: release.metadata.generation,
      lastAttemptedRevision: version,
      lastAttemptedRevisionDigest: digest,
      conditions: [
        {
          type: "Ready",
          status: runs ? "True" : "False",
          reason: runs ? "UpgradeSucceeded" : "UpgradeFailed",
          message: runs
            ? `Helm upgrade succeeded for release openbot/openbot with chart openbot-bundle@${version}`
            : "Helm upgrade failed: context deadline exceeded",
        },
      ],
      history: [
        { chartVersion: version, status: runs ? "deployed" : "failed" },
      ],
    };
  }
}

/** The accepted release is v1.1.0 on its chart. `pinnedTo` says where Flux and the pins are now. */
function cluster(pinnedTo: "failed" | "accepted") {
  const fake = new FakeCluster();
  const failed = pinnedTo === "failed";
  const chart = failed ? FAILED_CHART : ACCEPTED_CHART;
  const pins = failed
    ? pinsFor("v1.1.1", FAILED_IMAGE, "1".repeat(40))
    : pinsFor("v1.1.0", ACCEPTED_IMAGE, published.source.commit);
  fake.put({
    kind: "ConfigMap",
    metadata: { name: "openbot-agent-state", namespace: SYSTEM },
    data: {
      // journal.json was removed by the person who recovered.
      "state.json": JSON.stringify({
        accepted: {
          version: "v1.1.0",
          manifest: MANIFEST,
          digest: ACCEPTED_CHART,
        },
        previous: null,
        paused: false,
        suspendedByAgent: false,
        rolledBackFrom: null,
        handledCommands: [],
      }),
    },
  });
  fake.put({
    kind: "ConfigMap",
    metadata: { name: "openbot-agent-pins", namespace: SYSTEM },
    data: { "values.yaml": JSON.stringify(pins) },
  });
  fake.put({
    kind: "OCIRepository",
    metadata: { name: "openbot", namespace: SYSTEM, generation: 4 },
    spec: { suspend: false, ref: { digest: chart } },
  });
  fake.put({
    kind: "HelmRelease",
    metadata: { name: "openbot", namespace: SYSTEM, generation: 2 },
    spec: { suspend: false },
  });
  fake.put({
    kind: "Deployment",
    metadata: {
      name: "openbot-server",
      namespace: PRODUCT,
      labels: {
        "app.kubernetes.io/instance": "openbot",
        "app.kubernetes.io/component": "server",
      },
    },
    spec: {
      replicas: 1,
      template: {
        metadata: { annotations: {} },
        spec: { containers: [{ name: "server", image: "" }] },
      },
    },
  });
  // Flux's last attempt was that chart with those pins.
  fake.helmController();
  fake.mutations.length = 0;
  return fake;
}

async function managed(fake: FakeCluster, window: MaintenanceWindow) {
  const desired = {
    version: "v1.1.0",
    releaseManifestSha256: await releaseManifestDigest(MANIFEST),
    releaseManifest: MANIFEST,
    charts: {
      openbot: {
        ref: "oci://ghcr.io/copilotkit/charts/openbot",
        digest: ACCEPTED_CHART,
      },
      bundle: {
        ref: "oci://ghcr.io/copilotkit/charts/openbot-bundle",
        digest: ACCEPTED_CHART,
      },
    },
  };
  const heartbeats: Heartbeat[] = [];
  const client = {
    heartbeat: async (heartbeat: Heartbeat): Promise<HeartbeatReply> => {
      heartbeats.push(heartbeat);
      return { desired, window, paused: false, commands: [] };
    },
    result: async () => {},
  } as unknown as ManagementClient;
  const management = new ManagementAgent(
    agent,
    fake.kube,
    client,
    () => {},
    () => NOW,
  );
  return { management, heartbeats };
}

let fake: FakeCluster;
const originalFetch = globalThis.fetch;

describe("the accepted release is put back after a person recovers", () => {
  beforeEach(() => {
    // The server's internal status Service, answered by whatever the fake cluster runs.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== internalReleaseUrl(agent.config)) return originalFetch(input);
      const identity = fake.identity();
      if (!identity) throw new TypeError("fetch failed: connection refused");
      return Response.json(identity);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("inside the window: Flux is pinned to the accepted chart, its pins written and verified, with no backup", async () => {
    fake = cluster("failed");
    expect(fake.pinnedDigest).toBe(FAILED_CHART);
    const { management, heartbeats } = await managed(fake, INSIDE);

    // Hold the agent as it writes the pins, to see what it reports while it works.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.beforeChange = async (what) => {
      if (what === "apply ConfigMap/openbot-agent-pins") await held;
    };
    await management.tick();
    await management.tick();
    expect(heartbeats.at(-1)?.upgrade).toMatchObject({
      state: "upgrading",
      targetVersion: "v1.1.0",
    });
    release();
    await management.settle();

    expect(fake.pinnedDigest).toBe(ACCEPTED_CHART);
    expect(fake.pins.openbot.image).toEqual({
      repository: "ghcr.io/copilotkit/openbot",
      tag: "v1.1.0",
      digest: ACCEPTED_IMAGE,
    });
    expect(fake.serverImage).toEndWith(`@${ACCEPTED_IMAGE}`);
    const { state, journal } = fake.agentState;
    expect(journal).toMatchObject({
      phase: "accepted",
      toVersion: "v1.1.0",
      backupReference: "none",
    });
    expect(state.accepted.digest).toBe(ACCEPTED_CHART);
    // No backup Job: the person restored the database to this release's data.
    expect(
      fake.mutations.filter((entry) => !/^(apply|patch|annotate) /.test(entry)),
    ).toEqual([]);

    await management.tick();
    expect(heartbeats.at(-1)?.upgrade.state).toBe("idle");
    expect(heartbeats.at(-1)?.openbot.version).toBe("v1.1.0");
  });

  test("outside the window: it waits, and nothing changes", async () => {
    fake = cluster("failed");
    const { management, heartbeats } = await managed(fake, OUTSIDE);
    await management.tick();
    await management.tick();
    await management.settle();
    expect(heartbeats.at(-1)?.upgrade).toMatchObject({
      state: "waiting-window",
      targetVersion: "v1.1.0",
    });
    expect(fake.mutations).toEqual([]);
    expect(fake.pinnedDigest).toBe(FAILED_CHART);
    expect(fake.pins.openbot.image.digest).toBe(FAILED_IMAGE);
  });

  test("Flux already on the accepted release: nothing is done", async () => {
    fake = cluster("accepted");
    const { management, heartbeats } = await managed(fake, INSIDE);
    await management.tick();
    await management.tick();
    await management.settle();
    expect(fake.mutations).toEqual([]);
    expect(heartbeats.at(-1)?.upgrade).toMatchObject({
      state: "idle",
      targetVersion: null,
    });
    expect(fake.agentState.journal).toBeNull();
  });
});
