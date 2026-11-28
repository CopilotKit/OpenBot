/**
 * THE PRODUCT'S CHART IS CHECKED BEFORE ANYTHING IS TOUCHED FOR IT.
 *
 * With the chart's signature check on (`product.source.verify`), the agent has Flux check the chart
 * a desired version names on an OCIRepository of its own, before it records an install, quiesces,
 * backs up or pins the product's source. A chart that is unsigned or signed with another key is
 * refused: nothing is changed, the heartbeat says why, and it is not pulled again every minute. A
 * chart that verifies goes on to be pinned as before.
 *
 * The agent runs as it does on a cluster, through a real heartbeat over mutual TLS to the fake
 * management service; kubectl is scripted, holding Flux's objects in memory and answering as
 * source-controller does: a `reconcile.fluxcd.io/requestedAt` request is answered with Ready and
 * SourceVerified conditions (reason VerificationError for a chart the key does not verify,
 * Succeeded for one it does), each carrying the generation it judged, and `lastHandledReconcileAt`
 * set to the request (fluxcd.io/flux/components/source/ocirepositories, "Verification"). The real
 * verdicts on real charts are the kind tests': scripts/test-oci-charts-flux.sh in openbot-backend
 * for Flux itself, and agent-kind.test.ts for the agent.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import { rmSync } from "node:fs";
import { releaseManifestDigest } from "../../shared/management-contract";
import published from "../../shared/fixtures/releases/published-v1.1.0.json";
import { ManagementAgent } from "../src/agent";
import { ManagementClient } from "../src/client";
import { AgentConfig, type ReadyAgent } from "../src/config";
import { CommandFailed, Kube } from "../src/kube";
import { internalReleaseUrl } from "../src/status";
import {
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

const TEST_TIMEOUT_MS = 60_000;
const installId = "6d1f0c2a-8e4b-4c7a-9f3e-5b2a1d0e9c84";
const SIGNED = `sha256:${"5".repeat(64)}`;
const UNSIGNED = `sha256:${"e".repeat(64)}`;
const SOURCE = "ocirepositories.source.toolkit.fluxcd.io";
const RELEASE = "helmreleases.helm.toolkit.fluxcd.io";
const MANIFEST = JSON.stringify(published);

let pki: TestPki;
let fleet: FakeManagementService;
let url = "";
let internalStatus: Mock<typeof fetch>;
const kubeconfig = process.env.KUBECONFIG;

beforeAll(async () => {
  // The server's Deployment is read through a real kubectl; never against a cluster someone uses.
  process.env.KUBECONFIG = "/nonexistent/openbot-agent-chart-signature-test";
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

interface FluxObject {
  kind: string;
  metadata: {
    name: string;
    generation: number;
    annotations?: Record<string, string>;
  };
  spec: Record<string, unknown> & {
    ref?: { digest?: string };
    suspend?: boolean;
    verify?: unknown;
  };
  status?: Record<string, unknown>;
}

/** A JSON merge patch (RFC 7386), as `kubectl patch --type=merge` applies it. */
function merge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (typeof value === "object" && !Array.isArray(value))
      out[key] = merge(
        (out[key] as Record<string, unknown>) ?? {},
        value as Record<string, unknown>,
      );
    else out[key] = value;
  }
  return out;
}

/**
 * kubectl as the API server and Flux's controllers answer it. Charts whose digest is in `signed`
 * verify; every other chart is refused for its signature.
 */
function cluster(signed: Set<string>) {
  const objects = new Map<string, FluxObject>();
  const commands: string[][] = [];
  let state: Record<string, string> | null = null;
  const key = (resource: string, name: string) =>
    `${resource.startsWith("ocirepositor") ? SOURCE : RELEASE}/${name}`;

  /** What source-controller or helm-controller writes after acting on a request. */
  function reconcile(resource: string, object: FluxObject, token: string) {
    const generation = object.metadata.generation;
    if (resource.startsWith("ocirepositor")) {
      if (object.spec.suspend) return;
      const digest = object.spec.ref?.digest ?? "";
      const verified = !object.spec.verify || signed.has(digest);
      const at = { observedGeneration: generation };
      object.status = verified
        ? {
            observedGeneration: generation,
            lastHandledReconcileAt: token,
            artifact: { revision: digest, digest },
            conditions: [
              {
                type: "Ready",
                status: "True",
                reason: "Succeeded",
                message: `stored artifact for digest '${digest}'`,
                ...at,
              },
              ...(object.spec.verify
                ? [
                    {
                      type: "SourceVerified",
                      status: "True",
                      reason: "Succeeded",
                      message: `verified signature of revision ${digest}`,
                      ...at,
                    },
                  ]
                : []),
            ],
          }
        : {
            ...object.status,
            lastHandledReconcileAt: token,
            conditions: [
              {
                type: "Ready",
                status: "False",
                reason: "VerificationError",
                message: `failed to verify the signature using provider 'cosign': no matching signatures were found for 'registry.example.test/charts/openbot@${digest}'`,
                ...at,
              },
              {
                type: "SourceVerified",
                status: "False",
                reason: "VerificationError",
                message: `failed to verify the signature using provider 'cosign': no matching signatures were found for 'registry.example.test/charts/openbot@${digest}'`,
                ...at,
              },
            ],
          };
      return;
    }
    // helm-controller: it attempts only a chart its source has stored.
    const source = objects.get(`${SOURCE}/openbot`);
    const stored = source?.status?.artifact as { digest?: string } | undefined;
    if (!stored || stored.digest !== source?.spec.ref?.digest) {
      object.status = {
        ...object.status,
        lastHandledReconcileAt: token,
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason: "SourceNotReady",
            message: "OCIRepository is not ready",
            observedGeneration: generation,
          },
        ],
      };
      return;
    }
    object.status = {
      observedGeneration: generation,
      lastHandledReconcileAt: token,
      lastAttemptedRevisionDigest: stored.digest,
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "InstallFailed",
          message: "the scripted cluster runs no workloads",
          observedGeneration: generation,
        },
      ],
    };
  }

  const exec = async (
    command: readonly string[],
    options: { input?: string } = {},
  ) => {
    commands.push([...command]);
    const args = command.slice(1);
    const text = args.join(" ");
    if (text.includes("apply --server-side")) {
      const object = JSON.parse(options.input ?? "{}");
      // Server-side apply by one field manager: the keys it sends, beside the others.
      if (object.metadata?.name === "openbot-agent-state")
        state = { ...state, ...object.data };
      return "";
    }
    if (text.includes("get configmap openbot-agent-state")) {
      if (!state)
        throw new CommandFailed(
          [...command],
          1,
          "Error from server (NotFound)",
        );
      return JSON.stringify({ data: state });
    }
    if (args[0] === "create") {
      const object = JSON.parse(options.input ?? "{}") as FluxObject;
      object.metadata.generation = 1;
      const resource = object.kind === "OCIRepository" ? SOURCE : RELEASE;
      objects.set(`${resource}/${object.metadata.name}`, object);
      return "";
    }
    const verb = args[2];
    const resource = args[3] ?? "";
    const name = args[4] ?? "";
    if (
      /ocirepositor|helmrelease/.test(resource) ||
      /ocirepositor|helmrelease/.test(args[4] ?? "")
    ) {
      // annotate --overwrite <resource> <name> ...
      const [res, nm] =
        verb === "annotate" ? [args[4] ?? "", args[5] ?? ""] : [resource, name];
      const object = objects.get(key(res, nm));
      if (verb === "get") {
        if (!object)
          throw new CommandFailed(
            [...command],
            1,
            `Error from server (NotFound): ${res} "${nm}" not found`,
          );
        return JSON.stringify(object);
      }
      if (!object)
        throw new CommandFailed(
          [...command],
          1,
          "Error from server (NotFound)",
        );
      if (verb === "patch") {
        const patch = JSON.parse(args[args.indexOf("--patch") + 1] ?? "{}");
        const before = JSON.stringify(object.spec);
        Object.assign(
          object,
          merge(object as unknown as Record<string, unknown>, patch),
        );
        if (JSON.stringify(object.spec) !== before)
          object.metadata.generation += 1;
        return "";
      }
      if (verb === "annotate") {
        const values = args.slice(6);
        object.metadata.annotations = { ...object.metadata.annotations };
        for (const value of values) {
          const [k, v] = value.split("=");
          object.metadata.annotations[k ?? ""] = v ?? "";
        }
        const token =
          object.metadata.annotations["reconcile.fluxcd.io/requestedAt"];
        if (token) reconcile(res, object, token);
        return "";
      }
    }
    if (/ get (deployment|statefulset|pod)s? /.test(` ${text} `))
      return JSON.stringify({ items: [] });
    return "{}";
  };
  return {
    kube: new Kube(exec),
    commands,
    objects,
    state: () => state,
  };
}

function agent(): ReadyAgent {
  const config = AgentConfig.parse({
    managementUrl: url,
    installId,
    cloud: "other",
    commandPublicKey: fleet.publicKey,
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
        verify: { provider: "cosign", secretRef: "openbot-agent-cosign" },
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
    credentials: { cert: pki.client.cert, key: pki.client.key, ca: pki.ca },
    jobs: { backup: "kind: Job\n", supportBundle: "kind: Job\n" },
  };
}

async function desire(digest: string) {
  fleet.desired = {
    version: published.version,
    releaseManifestSha256: await releaseManifestDigest(MANIFEST),
    releaseManifest: MANIFEST,
    charts: {
      openbot: { ref: "oci://registry.example.test/charts/openbot", digest },
      bundle: {
        ref: "oci://registry.example.test/charts/openbot-bundle",
        digest,
      },
    },
  };
}

/** Waits, a little at a time, for `done`; the agent's operation runs beside the heartbeats. */
async function until(done: () => boolean, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !done()) await Bun.sleep(100);
}

const pinnedProduct = (objects: Map<string, FluxObject>) =>
  objects.get(`${SOURCE}/openbot`)?.spec.ref?.digest;
const check = (objects: Map<string, FluxObject>) =>
  objects.get(`${SOURCE}/openbot-signature-check`);

describe("the product's chart signature, checked before anything is touched", () => {
  test(
    "an unsigned or wrongly signed chart is refused: nothing changes, and the heartbeat says why",
    async () => {
      const { kube, commands, objects, state } = cluster(new Set([SIGNED]));
      const ready = agent();
      const management = new ManagementAgent(
        ready,
        kube,
        new ManagementClient(url, ready.credentials),
        () => {},
      );
      await desire(UNSIGNED);
      await management.tick();
      await until(
        () =>
          check(objects)?.spec.suspend === true ||
          pinnedProduct(objects) === UNSIGNED,
      );
      await management.settle();

      // Flux was asked about this chart, with the install's key, and said no.
      expect(check(objects)?.spec.ref?.digest).toBe(UNSIGNED);
      expect(check(objects)?.spec.verify).toEqual({
        provider: "cosign",
        secretRef: { name: "openbot-agent-cosign" },
      });
      // Nothing of the product was touched: its source is still on the placeholder, suspended;
      // no first install recorded, no journal, no pins, nothing scaled.
      expect(pinnedProduct(objects)).not.toBe(UNSIGNED);
      expect(objects.get(`${SOURCE}/openbot`)?.spec.suspend).toBe(true);
      expect(
        JSON.parse(state()?.["state.json"] ?? "{}").firstInstall ?? null,
      ).toBeNull();
      expect(state()?.["journal.json"]).toBeUndefined();
      expect(
        commands.some((c) => c.join(" ").includes("openbot-agent-pins")),
      ).toBe(false);
      expect(commands.some((c) => c.includes("scale"))).toBe(false);
      // The check object pulls nothing more once it has answered.
      expect(check(objects)?.spec.suspend).toBe(true);

      // The next heartbeat says why, and the chart is not pulled again at once.
      const requests = () =>
        commands.filter(
          (c) =>
            c.includes("annotate") && c.includes("openbot-signature-check"),
        ).length;
      const asked = requests();
      await management.tick();
      await management.settle();
      const journal = fleet.heartbeats.at(-1)?.upgrade.journal ?? "";
      expect(journal).toContain(
        `${published.version} refused, nothing was changed`,
      );
      expect(journal).toContain(UNSIGNED);
      expect(journal).toContain(
        "does not verify with this install's chart key",
      );
      expect(journal).toContain("no matching signatures");
      expect(requests()).toBe(asked);
      fleet.desired = null;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chart signed with the install's key is checked first, then pinned and installed",
    async () => {
      const { kube, commands, objects } = cluster(new Set([SIGNED]));
      const ready = agent();
      const management = new ManagementAgent(
        ready,
        kube,
        new ManagementClient(url, ready.credentials),
        () => {},
      );
      await desire(SIGNED);
      await management.tick();
      await until(() => pinnedProduct(objects) === SIGNED);

      expect(check(objects)?.spec.ref?.digest).toBe(SIGNED);
      expect(pinnedProduct(objects)).toBe(SIGNED);
      expect(objects.get(`${SOURCE}/openbot`)?.spec.verify).toEqual({
        provider: "cosign",
        secretRef: { name: "openbot-agent-cosign" },
      });
      // The check came first: Flux answered about the chart before the product's source moved.
      const at = (match: (line: string) => boolean) =>
        commands.findIndex((c) => match(c.join(" ")));
      const checked = at(
        (line) =>
          line.includes("annotate") && line.includes("openbot-signature-check"),
      );
      const pinned = at(
        (line) =>
          line.includes("patch") &&
          line.includes(` openbot --type=merge`) &&
          line.includes(SIGNED) &&
          line.includes(SOURCE),
      );
      expect(checked).toBeGreaterThanOrEqual(0);
      expect(pinned).toBeGreaterThan(checked);
      fleet.desired = null;
    },
    TEST_TIMEOUT_MS,
  );
});
