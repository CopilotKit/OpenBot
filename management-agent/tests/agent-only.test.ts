/**
 * The agent the product chart installs by default: connected, without upgrades. It heartbeats over
 * real mutual TLS to the fake management service, and never creates, reads, pins or suspends a Flux
 * object (no Flux runs beside it, and a cluster's own Flux is not its to touch); a desired version
 * waits with a line saying upgrades are not set up; pause, resume and rollback are refused with the
 * same reason; restart still works. The same config without `managedUpgrades: false` creates its
 * Flux objects as before.
 *
 * kubectl is scripted here (the commands are recorded and answered as the API server would); the
 * agent-only install on a real cluster is enroll-kind.test.ts and the chart's kind check.
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
import { ManagementAgent, UPGRADES_NOT_SET_UP } from "../src/agent";
import { ManagementClient } from "../src/client";
import { AgentConfig, type ReadyAgent } from "../src/config";
import { CommandFailed, Kube } from "../src/kube";
import { internalReleaseUrl } from "../src/status";
import {
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

// A heartbeat still reads the server's identity through a real kubectl when the status Service
// does not answer, and the first kubectl a cold CI runner starts can take seconds (these tests ran
// for about 3 to 4 seconds there against bun's 5-second default).
const HEARTBEAT_TEST_TIMEOUT_MS = 30_000;

const installId = "4e2a7c91-5b3d-4f08-a6e1-2c9d8b7f6a50";
let pki: TestPki;
let fleet: FakeManagementService;
let url = "";
let internalStatus: Mock<typeof fetch>;

beforeAll(async () => {
  pki = makePki(installId, ["127.0.0.1"]);
  fleet = new FakeManagementService(pki, installId);
  url = `https://127.0.0.1:${await fleet.start()}`;
  // Each heartbeat asks the server's internal status Service, a cluster name. Off a cluster that
  // name is looked up in the runner's DNS, which can take seconds the first time and push a test
  // past its timeout; there is no such Service here, so it is refused straight away, as a cluster
  // without one refuses it. Every other request (the management service) goes out as before.
  const realFetch = globalThis.fetch;
  const statusUrl = internalReleaseUrl(agent(false).config);
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
});

/** kubectl as the API server answers it, with the agent's state ConfigMap kept in memory. */
function scriptedKube() {
  const commands: string[][] = [];
  let state: Record<string, string> | null = null;
  const exec = async (
    command: readonly string[],
    options: { input?: string } = {},
  ) => {
    commands.push([...command]);
    const args = command.slice(1);
    const text = args.join(" ");
    if (text.includes("apply --server-side")) {
      const object = JSON.parse(options.input ?? "{}");
      if (object.kind === "ConfigMap") state = object.data;
      return "";
    }
    if (text.includes("get configmap openbot-agent-state")) {
      if (!state)
        throw new CommandFailed(
          [...command],
          1,
          'Error from server (NotFound): configmaps "openbot-agent-state" not found',
        );
      return JSON.stringify({ data: state });
    }
    if (/ get (deployment|statefulset)s? /.test(` ${text} `)) {
      const items =
        text.includes("deployment") && text.includes("--selector")
          ? [{ metadata: { name: "openbot-server" } }]
          : [];
      return JSON.stringify({ items });
    }
    if (/ get (pods|deployments|statefulsets) /.test(` ${text} `))
      return JSON.stringify({ items: [] });
    if (text.includes("rollout")) return "";
    if (text.includes("ocirepositor") || text.includes("helmrelease"))
      throw new CommandFailed([...command], 1, "Error from server (NotFound)");
    return "{}";
  };
  return { kube: new Kube(exec), commands };
}

function agent(managedUpgrades: boolean | undefined): ReadyAgent {
  const config = AgentConfig.parse({
    managementUrl: url,
    installId,
    ...(managedUpgrades === undefined ? {} : { managedUpgrades }),
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
    credentials: { cert: pki.client.cert, key: pki.client.key, ca: pki.ca },
    jobs: { backup: "kind: Job\n", supportBundle: "kind: Job\n" },
  };
}

const fluxCommands = (commands: string[][]) =>
  commands.filter((command) =>
    /ocirepositor|helmrelease|toolkit\.fluxcd\.io/i.test(command.join(" ")),
  );

describe("the agent without upgrades set up", () => {
  test(
    "heartbeats, and touches no Flux object even with a desired version waiting",
    async () => {
      const { kube, commands } = scriptedKube();
      const ready = agent(false);
      const management = new ManagementAgent(
        ready,
        kube,
        new ManagementClient(url, ready.credentials),
        () => {},
      );
      fleet.desired = {
        version: "v1.2.0",
        releaseManifestSha256: "0".repeat(64),
        releaseManifest: "{}",
        charts: {
          openbot: {
            ref: "oci://registry.example.test/charts/openbot",
            digest: `sha256:${"a".repeat(64)}`,
          },
          bundle: {
            ref: "oci://registry.example.test/charts/openbot-bundle",
            digest: `sha256:${"b".repeat(64)}`,
          },
        },
      };
      const before = fleet.heartbeats.length;
      await management.tick();
      await management.tick();
      fleet.desired = null;
      expect(fleet.heartbeats.length).toBe(before + 2);
      const last = fleet.heartbeats.at(-1);
      expect(last?.installId).toBe(installId);
      expect(last?.flux.helmReleases).toEqual([]);
      expect(last?.upgrades).toBe("not-set-up");
      expect(last?.upgrade.state).toBe("idle");
      expect(last?.upgrade.journal).toContain("upgrades are not set up");
      expect(last?.upgrade.journal).toContain(UPGRADES_NOT_SET_UP);
      expect(fluxCommands(commands)).toEqual([]);
    },
    HEARTBEAT_TEST_TIMEOUT_MS,
  );

  test(
    "refuses pause, resume and rollback, and still restarts",
    async () => {
      const { kube, commands } = scriptedKube();
      const ready = agent(false);
      const management = new ManagementAgent(
        ready,
        kube,
        new ManagementClient(url, ready.credentials),
        () => {},
      );
      for (const kind of ["pause", "resume", "rollback", "restart"] as const)
        await fleet.command({ id: `cmd-${kind}`, kind, args: {} });
      await management.tick();
      const results = Object.fromEntries(
        fleet.results.map((result) => [result.commandId, result]),
      );
      for (const kind of ["pause", "resume", "rollback"]) {
        expect(results[`cmd-${kind}`]?.ok).toBe(false);
        expect(results[`cmd-${kind}`]?.reason).toBe(
          `upgrades are not set up: ${UPGRADES_NOT_SET_UP}`,
        );
      }
      expect(results["cmd-restart"]?.ok).toBe(true);
      expect(
        commands.some((command) =>
          command
            .join(" ")
            .includes("rollout restart deployment/openbot-server"),
        ),
      ).toBe(true);
      expect(fluxCommands(commands)).toEqual([]);
    },
    HEARTBEAT_TEST_TIMEOUT_MS,
  );

  test(
    "with upgrades on (the setting absent), the agent creates its Flux objects as before",
    async () => {
      const { kube, commands } = scriptedKube();
      const ready = agent(undefined);
      const management = new ManagementAgent(
        ready,
        kube,
        new ManagementClient(url, ready.credentials),
        () => {},
      );
      await management.tick();
      expect(fluxCommands(commands).length).toBeGreaterThan(0);
      expect(fleet.heartbeats.at(-1)?.upgrades).toBe("on");
    },
    HEARTBEAT_TEST_TIMEOUT_MS,
  );
});
