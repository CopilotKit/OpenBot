/**
 * What the agent installs comes only from a signed desired state: one that verifies with the command
 * key, names this install, has not expired and was not replayed. The reply's unsigned fields name
 * nothing it installs, and a release older than the accepted one is refused.
 *
 * The agent heartbeats over real mutual TLS to the fake management service, which signs the desired
 * state as the service does. kubectl is scripted (the commands are answered as the API server would,
 * with the agent's ConfigMaps and the product's Flux objects kept in memory), and no real cluster is
 * reachable from here. A pin is the agent pointing Flux's OCIRepository at a chart digest: that is the
 * agent applying a release. The scripted HelmRelease then reports the install failed, so the agent's
 * operation ends at once.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type DesiredState,
  releaseManifestDigest,
} from "../../shared/management-contract";
import { ManagementAgent, olderRelease } from "../src/agent";
import { ManagementClient } from "../src/client";
import { AgentConfig, type ReadyAgent } from "../src/config";
import { CommandFailed, Kube } from "../src/kube";
import { internalReleaseUrl } from "../src/status";
import {
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

const TIMEOUT_MS = 60_000;
const installId = "9c4e1f7a-2b3d-4e5f-8a6b-1c2d3e4f5a6b";
const otherInstall = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OCI = "ocirepositories.source.toolkit.fluxcd.io";
const HELM = "helmreleases.helm.toolkit.fluxcd.io";

let pki: TestPki;
let fleet: FakeManagementService;
let url = "";
let internalStatus: Mock<typeof fetch>;
const kubeconfig = process.env.KUBECONFIG;

beforeAll(async () => {
  // Nothing here may reach a real cluster: the promotion steps run kubectl themselves.
  process.env.KUBECONFIG = "/nonexistent/openbot-agent-test-kubeconfig";
  pki = makePki(installId, ["127.0.0.1"]);
  fleet = new FakeManagementService(pki, installId);
  url = `https://127.0.0.1:${await fleet.start()}`;
  const realFetch = globalThis.fetch;
  const statusUrl = internalReleaseUrl(agent().config);
  internalStatus = spyOn(globalThis, "fetch").mockImplementation(((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target === statusUrl)
      return Promise.reject(new TypeError("fetch failed: connection refused"));
    return realFetch(input, init);
  }) as typeof fetch);
});
afterAll(() => {
  internalStatus.mockRestore();
  fleet.stop();
  rmSync(pki.directory, { recursive: true, force: true });
  if (kubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = kubeconfig;
});
beforeEach(() => {
  fleet.desired = null;
  fleet.unsignedDesired = undefined;
  fleet.signedDesired = undefined;
  fleet.tamper = null;
  fleet.paused = false;
  fleet.window = { weekday: 0, startUtc: "00:00", hours: 168 };
});

function agent(): ReadyAgent {
  const config = AgentConfig.parse({
    managementUrl: url || "https://127.0.0.1:1",
    installId,
    cloud: "other",
    commandPublicKey:
      fleet?.publicKey || Buffer.alloc(32, 7).toString("base64"),
    window: null,
    agentNamespace: "openbot-system",
    product: {
      chart: "openbot",
      releaseName: "openbot",
      namespace: "openbot",
      helmRelease: "openbot",
      ociRepository: "openbot",
      pinsConfigMap: "openbot-agent-pins",
      source: {
        url: "oci://registry.example.test/charts/openbot",
        digest: null,
        insecure: false,
        pullSecret: null,
        verify: null,
      },
      release: {
        serviceAccountName: "openbot-deployer",
        timeout: "15m",
        valuesFrom: [],
      },
    },
    backup: { kind: "none", timeoutSeconds: 900 },
    stateConfigMap: "openbot-agent-state",
    supportBundle: { pvc: "openbot-support-bundles" },
  }) as ReadyAgent["config"];
  return {
    config,
    credentials: { cert: pki?.client.cert, key: pki?.client.key, ca: pki?.ca },
    jobs: { backup: "kind: Job\n", supportBundle: "kind: Job\n" },
  };
}

type Data = Record<string, string>;
interface FluxObject {
  metadata: { name: string; generation?: number; annotations?: Data };
  spec: Record<string, unknown> & { ref?: { digest?: string } };
  status?: Record<string, unknown>;
}

function merge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof target[key] === "object" &&
      target[key] !== null
    )
      merge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    else target[key] = value;
  }
}

/** kubectl as the API server answers it, with the ConfigMaps and the two Flux objects in memory. */
function scriptedCluster(initial: Data | null = null) {
  const configMaps = new Map<string, Data>();
  if (initial) configMaps.set("openbot-agent-state", { ...initial });
  const flux = new Map<string, FluxObject>();
  const pins: string[] = [];
  const notFound = (command: readonly string[], what: string) =>
    new CommandFailed(
      [...command],
      1,
      `Error from server (NotFound): ${what} not found`,
    );
  const exec = async (
    command: readonly string[],
    options: { input?: string } = {},
  ) => {
    const args = command.slice(1).filter((arg, index, all) => {
      // Drop "--namespace <ns>" so the verbs line up.
      if (arg === "--namespace") return false;
      return all[index - 1] !== "--namespace";
    });
    const [verb, resource, name] = args;
    if (verb === "apply") {
      const object = JSON.parse(options.input ?? "{}");
      if (object.kind === "ConfigMap")
        configMaps.set(object.metadata.name, { ...object.data });
      return "";
    }
    if (verb === "create") {
      const object = JSON.parse(options.input ?? "{}");
      const key = object.kind === "OCIRepository" ? OCI : HELM;
      flux.set(key, {
        ...object,
        metadata: { ...object.metadata, generation: 1 },
      });
      return `${object.kind}/${object.metadata.name}`;
    }
    if (verb === "get" && resource === "configmap" && name) {
      const data = configMaps.get(name);
      if (!data) throw notFound(command, `configmaps "${name}"`);
      return JSON.stringify({ data });
    }
    if (verb === "get" && (resource === OCI || resource === HELM)) {
      const object = flux.get(resource);
      if (!object) throw notFound(command, resource);
      return JSON.stringify(object);
    }
    if (verb === "patch" && resource && name) {
      const patch = JSON.parse(args[args.indexOf("--patch") + 1] ?? "{}");
      if (resource === "configmap") {
        const data = configMaps.get(name);
        if (!data) throw notFound(command, `configmaps "${name}"`);
        merge(data, patch.data ?? {});
        return "";
      }
      const object = flux.get(resource);
      if (!object) throw notFound(command, resource);
      merge(object as unknown as Record<string, unknown>, patch);
      if (resource === OCI && patch.spec?.ref?.digest)
        pins.push(patch.spec.ref.digest);
      return "";
    }
    if (verb === "annotate") {
      const target = args[2];
      const object = target ? flux.get(target) : undefined;
      const token = args
        .find((arg) => arg.startsWith("reconcile.fluxcd.io/requestedAt="))
        ?.split("=")[1];
      if (object && target === HELM && token)
        // helm-controller acted on the request, and the install failed: no cluster here runs it.
        object.status = {
          observedGeneration: object.metadata.generation,
          lastHandledReconcileAt: token,
          lastAttemptedRevisionDigest: flux.get(OCI)?.spec.ref?.digest,
          conditions: [
            {
              type: "Ready",
              status: "False",
              reason: "InstallFailed",
              message: "no workloads run on this scripted cluster",
            },
          ],
        };
      return "";
    }
    if (verb === "get") return JSON.stringify({ items: [] });
    return "{}";
  };
  return {
    kube: new Kube(exec),
    configMaps,
    /** Every chart digest the agent pinned Flux to, in order. */
    pins,
    pinnedImage: () =>
      configMaps.get("openbot-agent-pins")?.["values.yaml"] ?? "",
  };
}

const PUBLISHED = readFileSync(
  join(import.meta.dir, "../../shared/fixtures/releases/published-v1.1.0.json"),
  "utf8",
);
/** A release as CopilotKit publishes it: `version`, upgradable from `from`, with its own image. */
async function release(
  version: string,
  options: { from?: string[]; image: string; chart: string },
): Promise<DesiredState> {
  const manifest = JSON.parse(PUBLISHED);
  manifest.version = version;
  manifest.upgrade.fromVersions = options.from ?? [];
  manifest.upgrade.recovery = "restart-previous";
  manifest.compatibility.database.rollbackCompatible = true;
  manifest.compatibility.database.from = [manifest.compatibility.database.to];
  manifest.artifacts.images.openbot.reference = `ghcr.io/copilotkit/openbot@sha256:${options.image.repeat(64)}`;
  const releaseManifest = JSON.stringify(manifest);
  return {
    version,
    releaseManifestSha256: await releaseManifestDigest(releaseManifest),
    releaseManifest,
    charts: {
      openbot: {
        ref: "oci://registry.example.test/charts/openbot",
        digest: `sha256:${options.chart.repeat(64)}`,
      },
      bundle: {
        ref: "oci://registry.example.test/charts/openbot-bundle",
        digest: `sha256:${options.chart.repeat(64)}`,
      },
    },
  };
}

function managed(cluster: ReturnType<typeof scriptedCluster>) {
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const ready = agent();
  const management = new ManagementAgent(
    ready,
    cluster.kube,
    new ManagementClient(url, ready.credentials),
    (message, fields) => logs.push({ message, fields }),
  );
  return { management, logs };
}

/** A tick, then the operation it started (if any) to its end, then one more heartbeat to read. */
async function tickAndReport(management: ManagementAgent) {
  await management.tick();
  await management.settle();
  await management.tick();
  return fleet.heartbeats.at(-1);
}

const refusals = (
  logs: { message: string; fields?: Record<string, unknown> }[],
) => logs.filter((entry) => entry.message === "desired state refused");

describe("the desired state the agent acts on", () => {
  test(
    "a properly signed upgrade is applied: Flux is pinned to the signed chart, with the signed image",
    async () => {
      const cluster = scriptedCluster();
      const { management } = managed(cluster);
      fleet.desired = await release("v1.2.0", { image: "1", chart: "a" });
      // Only the signed form names it: the reply's unsigned field says nothing.
      fleet.unsignedDesired = null;
      await tickAndReport(management);
      expect(cluster.pins).toEqual([`sha256:${"a".repeat(64)}`]);
      expect(cluster.pinnedImage()).toContain(`sha256:${"1".repeat(64)}`);
    },
    TIMEOUT_MS,
  );

  test(
    "a tampered reply naming another version or image is refused, and nothing is pinned",
    async () => {
      const cluster = scriptedCluster();
      const { management, logs } = managed(cluster);
      fleet.desired = await release("v1.2.0", { image: "1", chart: "a" });
      const forged = await release("v6.6.6", { image: "6", chart: "6" });
      // Something between the service and the agent rewrites the reply: the unsigned field, and the
      // signed desired state's release, keeping its signature.
      fleet.tamper = (reply) => {
        reply.desired = forged;
        for (const entry of reply.commands as {
          kind?: string;
          desired?: unknown;
        }[])
          if (entry.kind === "desired-state") entry.desired = forged;
      };
      const last = await tickAndReport(management);
      expect(cluster.pins).toEqual([]);
      expect(cluster.pinnedImage()).toBe("");
      expect(last?.upgrade.journal).toContain(
        "desired state refused: signature does not verify",
      );
      expect(refusals(logs)[0]?.fields?.reason).toBe(
        "signature does not verify",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "an unsigned desired state is refused: the reply's own fields install nothing",
    async () => {
      const cluster = scriptedCluster();
      const { management } = managed(cluster);
      fleet.desired = await release("v1.2.0", { image: "1", chart: "a" });
      fleet.signedDesired = null;
      const last = await tickAndReport(management);
      expect(cluster.pins).toEqual([]);
      expect(last?.upgrade.journal).toContain(
        "desired state refused: the reply carries no signed desired state",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "an expired desired state is refused",
    async () => {
      const cluster = scriptedCluster();
      const { management } = managed(cluster);
      fleet.desired = await release("v1.2.0", { image: "1", chart: "a" });
      fleet.signedDesired = await fleet.signDesired({
        issuedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
      const last = await tickAndReport(management);
      expect(cluster.pins).toEqual([]);
      expect(last?.upgrade.journal).toContain(
        "desired state refused: expired at",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a replayed desired state is refused, also after the agent restarts",
    async () => {
      const cluster = scriptedCluster();
      // Signed earlier, naming a release: what someone in the path kept to send again later.
      fleet.desired = await release("v1.2.0", { image: "1", chart: "a" });
      const kept = await fleet.signDesired();
      // Since then the service has signed newer ones naming nothing, and the agent accepted one.
      fleet.desired = null;
      const first = managed(cluster);
      await first.management.tick();
      const accepted = JSON.parse(
        cluster.configMaps.get("openbot-agent-state")?.["desired.json"] ?? "{}",
      );
      expect(accepted).toEqual({
        installId,
        counter: fleet.counter,
        signature: expect.any(String),
      });
      // The old one comes back, with the unsigned field to match. The agent is a new process: the
      // counter it accepted is read back from its state ConfigMap.
      fleet.signedDesired = kept;
      fleet.unsignedDesired = kept.desired;
      const { management, logs } = managed(cluster);
      const last = await tickAndReport(management);
      expect(cluster.pins).toEqual([]);
      expect(last?.upgrade.journal).toContain(
        `desired state refused: replayed: counter ${kept.counter} is below ${accepted.counter}`,
      );
      expect(refusals(logs).length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the same signed desired state sent again is the one already accepted, not a replay",
    async () => {
      const cluster = scriptedCluster();
      const { management } = managed(cluster);
      fleet.signedDesired = await fleet.signDesired();
      await management.tick();
      const last = await tickAndReport(management);
      expect(last?.upgrade.journal ?? "").not.toContain("refused");
    },
    TIMEOUT_MS,
  );

  test(
    "one signed for another install is refused",
    async () => {
      const cluster = scriptedCluster();
      const { management } = managed(cluster);
      fleet.desired = await release("v1.2.0", { image: "1", chart: "a" });
      fleet.signedDesired = await fleet.signDesired({
        installId: otherInstall,
      });
      const last = await tickAndReport(management);
      expect(cluster.pins).toEqual([]);
      expect(last?.upgrade.journal).toContain(
        `desired state refused: signed for another install (${otherInstall})`,
      );
    },
    TIMEOUT_MS,
  );
});

describe("downgrades", () => {
  /** The agent has accepted v1.2.0, and Flux is pinned to it. */
  async function acceptedCluster(extra: Record<string, unknown> = {}) {
    const accepted = await release("v1.2.0", {
      from: ["v1.1.0"],
      image: "2",
      chart: "b",
    });
    const cluster = scriptedCluster({
      "state.json": JSON.stringify({
        accepted: {
          version: accepted.version,
          manifest: accepted.releaseManifest,
          digest: accepted.charts.openbot.digest,
        },
        previous: null,
        paused: false,
        suspendedByAgent: false,
        rolledBackFrom: null,
        firstInstall: null,
        handledCommands: [],
        ...extra,
      }),
    });
    return { cluster, accepted };
  }

  test("older means an older release version; a main build's name is not one", () => {
    // Release tags as published, release candidates, and the broken builds the kind test makes.
    expect(olderRelease("v1.1.0", "v1.2.0")).toBe(true);
    expect(olderRelease("v1.2.0-rc.3", "v1.2.0")).toBe(true);
    expect(olderRelease("v1.9.0", "v1.10.0")).toBe(true);
    expect(olderRelease("v1.2.0", "v1.1.0")).toBe(false);
    expect(olderRelease("v1.2.0", "v1.2.0")).toBe(false);
    expect(olderRelease("v1.1.1-rc.1-broken", "v1.1.1-rc.1")).toBe(false);
    // A main build (main-<date>-<run>) has no release version to order by: its signed manifest's
    // upgrade path decides, as for any move.
    expect(olderRelease("main-20261119-219", "v1.2.0")).toBe(false);
    expect(olderRelease("v1.2.0", "main-20261119-219")).toBe(false);
  });

  test(
    "a signed release older than the accepted one is refused, logged and reported",
    async () => {
      const { cluster } = await acceptedCluster();
      const { management, logs } = managed(cluster);
      // Signed, and its manifest even lists the installed version as one it upgrades from.
      fleet.desired = await release("v1.1.0", {
        from: ["v1.2.0"],
        image: "1",
        chart: "a",
      });
      const last = await tickAndReport(management);
      expect(cluster.pins).toEqual([]);
      expect(logs.some((entry) => entry.message === "operation failed")).toBe(
        false,
      );
      expect(last?.upgrade.state).toBe("idle");
      expect(last?.upgrade.journal).toContain(
        "downgrade to v1.1.0 refused: v1.2.0 is installed",
      );
      expect(logs.some((entry) => entry.message === "downgrade refused")).toBe(
        true,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "after a signed rollback, the release rolled back to is no downgrade and the one rolled back from waits",
    async () => {
      const { cluster, accepted } = await acceptedCluster({
        rolledBackFrom: "v1.3.0",
      });
      // Flux is on the accepted release: a desired state naming it changes nothing.
      const { management } = managed(cluster);
      await management.tick();
      const oci = await cluster.kube.get<FluxObject>(
        "openbot-system",
        OCI,
        "openbot",
      );
      expect(oci).not.toBeNull();
      await cluster.kube.patch("openbot-system", OCI, "openbot", {
        spec: { ref: { digest: accepted.charts.openbot.digest } },
      });
      cluster.pins.length = 0;
      fleet.desired = accepted;
      let last = await tickAndReport(management);
      expect(last?.upgrade.journal ?? "").not.toContain("refused");
      expect(cluster.pins).toEqual([]);
      // The release it was rolled back from is not moved to again.
      fleet.desired = await release("v1.3.0", {
        from: ["v1.2.0"],
        image: "3",
        chart: "c",
      });
      last = await tickAndReport(management);
      expect(last?.upgrade.journal ?? "").not.toContain("refused");
      expect(cluster.pins).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
