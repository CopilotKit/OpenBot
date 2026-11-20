/**
 * The backup target guard end to end, on a real cluster with two real RDS for PostgreSQL instances:
 * the product (a real openbot-bundle) runs on one of them, and the `openbot-agent` chart's backup
 * values (`backup.kind=rds-snapshot`) name the other, as they did after a restore to a new database
 * server when a `helm upgrade --reuse-values` put the old server back.
 *
 *  1. first install of the first build, on the product's instance; its server reports that instance
 *     on /release;
 *  2. a migrating upgrade, inside the window, with the backup values on the OTHER instance: the
 *     agent refuses before it touches anything. No quiescing, no snapshot of either instance, Flux
 *     left where it was; journal.json says `recovery-required` and why, and so does the heartbeat;
 *  3. a person points the values at the product's instance (helm upgrade openbot-agent) and clears
 *     the journal: the agent confirms the target, snapshots the product's instance (verified
 *     available by RDS), then upgrades.
 *
 * Opt-in: it needs a cluster whose backup Jobs can call RDS (on kind on EC2, the instance's own
 * role through IMDS with a hop limit of 3), two RDS instances it may snapshot, and release builds
 * whose server reports its database. As agent-kind.test.ts, plus:
 *
 *   OPENBOT_AGENT_E2E_RDS_REGION=us-east-2
 *   OPENBOT_AGENT_E2E_RDS_PRODUCT=openbot-btg-a   the instance the product's values use
 *   OPENBOT_AGENT_E2E_RDS_OTHER=openbot-btg-b     another instance in the same account
 *   OPENBOT_AGENT_E2E_VALUES=/path/values.yaml    the bundle's values, on the product's instance
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseManifestDigest } from "../../shared/management-contract";
import {
  FakeManagementService,
  makePki,
  type TestPki,
} from "./fake-management-service";

setDefaultTimeout(3_600_000);
const env = process.env;
const kubeconfig = env.OPENBOT_AGENT_E2E_KUBECONFIG;
const region = env.OPENBOT_AGENT_E2E_RDS_REGION ?? "";
const productInstance = env.OPENBOT_AGENT_E2E_RDS_PRODUCT ?? "";
const otherInstance = env.OPENBOT_AGENT_E2E_RDS_OTHER ?? "";
const installId = "5c1f0b8e-7a2d-4c3e-9f61-2b4d6e8a0c13";
const SYSTEM = "openbot-system";
const PRODUCT = "openbot";

function sh(command: string, args: string[], input?: string) {
  return execFileSync(command, args, {
    encoding: "utf8",
    input,
    env: { ...env, KUBECONFIG: kubeconfig },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
const kubectl = (...args: string[]) => sh("kubectl", args);
const json = <T>(...args: string[]) =>
  JSON.parse(kubectl(...args, "-o", "json")) as T;
const aws = <T>(...args: string[]) =>
  JSON.parse(sh("aws", [...args, "--region", region, "--output", "json"])) as T;
async function shAsync(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], {
    env: { ...env, KUBECONFIG: kubeconfig },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}
async function until<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  minutes = 20,
) {
  const deadline = Date.now() + minutes * 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

interface Build {
  version: string;
  manifest: string;
  digest: string;
}
function push(version: string): Build {
  const directory = join(env.OPENBOT_AGENT_E2E_RELEASES ?? "", version);
  const chart = readdirSync(directory).find(
    (file) => file.startsWith("openbot-bundle-") && file.endsWith(".tgz"),
  );
  if (!chart) throw new Error(`no bundle chart in ${directory}`);
  const pushed = spawnSync(
    "helm",
    [
      "push",
      join(directory, chart),
      `oci://${env.OPENBOT_AGENT_E2E_PUSH}/charts`,
      "--plain-http",
    ],
    { encoding: "utf8" },
  );
  if (pushed.status !== 0)
    throw new Error(`helm push failed: ${pushed.stderr}`);
  const digest = `${pushed.stdout}${pushed.stderr}`.match(
    /Digest:\s*(sha256:[0-9a-f]{64})/,
  )?.[1];
  if (!digest) throw new Error("helm push printed no digest");
  return {
    version,
    manifest: readFileSync(
      join(env.OPENBOT_AGENT_E2E_RELEASES ?? "", `${version}.json`),
      "utf8",
    ),
    digest,
  };
}

/** Manual snapshots of an instance the agent took (`openbot-<operation>`). */
function agentSnapshots(instance: string) {
  return aws<{
    DBSnapshots: { DBSnapshotIdentifier: string; Status: string }[];
  }>(
    "rds",
    "describe-db-snapshots",
    "--db-instance-identifier",
    instance,
    "--snapshot-type",
    "manual",
  ).DBSnapshots.filter((snapshot) =>
    snapshot.DBSnapshotIdentifier.startsWith("openbot-"),
  );
}
function endpoint(instance: string) {
  return aws<{ DBInstances: { Endpoint: { Address: string } }[] }>(
    "rds",
    "describe-db-instances",
    "--db-instance-identifier",
    instance,
  ).DBInstances[0]?.Endpoint.Address;
}

const run =
  kubeconfig && productInstance && otherInstance ? describe : describe.skip;
let pki: TestPki;
let service: FakeManagementService;
let from: Build;
let to: Build;
let valuesFile = "";

async function desire(build: Build) {
  const ref = (name: string) => ({
    ref: `oci://${env.OPENBOT_AGENT_E2E_PULL}/charts/${name}`,
    digest: build.digest,
  });
  service.desired = {
    version: build.version,
    releaseManifestSha256: await releaseManifestDigest(build.manifest),
    releaseManifest: build.manifest,
    charts: { openbot: ref("openbot"), bundle: ref("openbot-bundle") },
  };
}
const latest = () => service.heartbeats.at(-1);
const pinned = () =>
  json<{ spec: { ref?: { digest?: string } } }>(
    "-n",
    SYSTEM,
    "get",
    "ocirepositories.source.toolkit.fluxcd.io",
    "openbot",
  ).spec.ref?.digest;
const journal = () =>
  JSON.parse(
    json<{ data?: Record<string, string> }>(
      "-n",
      SYSTEM,
      "get",
      "configmap",
      "openbot-agent-state",
    ).data?.["journal.json"] ?? "null",
  );
const server = () =>
  json<{
    items: {
      metadata: { generation: number };
      spec: { replicas?: number };
    }[];
  }>(
    "-n",
    PRODUCT,
    "get",
    "deployment",
    "-l",
    "app.kubernetes.io/instance=openbot,app.kubernetes.io/component=server",
  ).items[0];

function agentValues(instance: string, host: string, port: number) {
  const [repository, tag] = (env.OPENBOT_AGENT_E2E_IMAGE ?? "").split(":");
  return {
    installId,
    commandPublicKey: service.publicKey,
    cloud: "aws",
    management: {
      url: `https://${host}:${port}`,
      credentialsSecret: "openbot-agent-credentials",
    },
    window: { weekday: 0, startUtc: "00:00", hours: 168 },
    product: {
      chart: "bundle",
      releaseName: "openbot",
      namespace: PRODUCT,
      url: `oci://${env.OPENBOT_AGENT_E2E_PULL}/charts/openbot-bundle`,
      insecure: true,
      valuesFrom: [
        { kind: "Secret", name: "openbot-values", valuesKey: "values.yaml" },
      ],
      timeout: "20m",
    },
    backup: {
      kind: "rds-snapshot",
      timeoutSeconds: 3600,
      rdsSnapshot: { region, instance },
    },
    agent: { image: { repository, tag } },
  };
}
let port = 0;
async function installAgent(instance: string) {
  const host = env.OPENBOT_AGENT_E2E_HOST ?? "";
  writeFileSync(valuesFile, JSON.stringify(agentValues(instance, host, port)));
  await shAsync("helm", [
    "upgrade",
    "--install",
    "openbot-agent",
    env.OPENBOT_AGENT_E2E_CHART ?? "",
    "-n",
    SYSTEM,
    "--values",
    valuesFile,
  ]);
  await shAsync("kubectl", [
    "-n",
    SYSTEM,
    "rollout",
    "status",
    "deployment/openbot-agent",
    "--timeout=5m",
  ]);
}

run("backup target guard on a real cluster and real RDS", () => {
  beforeAll(async () => {
    const host = env.OPENBOT_AGENT_E2E_HOST ?? "";
    pki = makePki(installId, [host]);
    service = new FakeManagementService(pki, installId);
    port = (await service.start(0, "0.0.0.0")) ?? 0;
    valuesFile = join(pki.directory, "agent-values.json");
    from = push(env.OPENBOT_AGENT_E2E_FROM ?? "");
    to = push(env.OPENBOT_AGENT_E2E_TO ?? "");
    expect(from.digest).not.toBe(to.digest);
    for (const instance of [productInstance, otherInstance])
      expect(agentSnapshots(instance)).toEqual([]);

    for (const namespace of [SYSTEM, PRODUCT])
      sh(
        "kubectl",
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespace },
        }),
      );
    const secret = (
      name: string,
      namespace: string,
      data: Record<string, string>,
    ) =>
      sh(
        "kubectl",
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name, namespace },
          stringData: data,
        }),
      );
    secret("openbot-agent-credentials", SYSTEM, {
      "tls.crt": pki.client.cert,
      "tls.key": pki.client.key,
      "ca.crt": pki.ca,
    });
    secret("openbot-values", SYSTEM, {
      "values.yaml": readFileSync(env.OPENBOT_AGENT_E2E_VALUES ?? "", "utf8"),
    });
    // Wrong from the start, as after the restore: the product's values say one instance, the
    // agent's backup values the other.
    await installAgent(otherInstance);
  });

  afterAll(() => {
    service?.stop();
    if (pki) rmSync(pki.directory, { recursive: true, force: true });
  });

  test("installs the first build on the product's instance, whose server reports it", async () => {
    service.window = {
      weekday: (new Date().getUTCDay() + 3) % 7,
      startUtc: "00:00",
      hours: 4,
    };
    await desire(from);
    await until(
      `${from.version} installed and verified`,
      () => {
        const last = latest();
        return (
          last?.openbot.version === from.version &&
          last.upgrade.state === "idle" &&
          last
        );
      },
      40,
    );
    expect(pinned()).toBe(from.digest);
    // What the agent reads: /release on the server's internal status Service.
    const release = JSON.parse(
      kubectl(
        "-n",
        SYSTEM,
        "run",
        `release-${Date.now()}`,
        "--rm",
        "-i",
        "--restart=Never",
        "--quiet",
        "--image=curlimages/curl:8.17.0",
        "--",
        "curl",
        "-fsS",
        `http://openbot-server-internal.${PRODUCT}.svc:9464/release`,
      ),
    );
    expect(release.database).toEqual({ host: endpoint(productInstance) });
  });

  test("backup values on another instance: refused before anything is touched, and said why", async () => {
    const before = server();
    expect(before?.spec.replicas).toBeGreaterThan(0);
    service.window = { weekday: 0, startUtc: "00:00", hours: 168 };
    await desire(to);
    const refused = await until(
      "the upgrade refused",
      () => {
        const entry = journal();
        return (
          entry?.toVersion === to.version &&
          entry.phase === "recovery-required" &&
          entry
        );
      },
      15,
    );
    expect(refused.databaseMayHaveChanged).toBe(false);
    expect(refused.backupReference).toBe("none");
    expect(refused.error).toContain("backup target refused");
    expect(refused.error).toContain(
      `backup.rdsSnapshot.instance=${otherInstance}`,
    );
    expect(refused.error).toContain(
      `the product's server uses ${endpoint(productInstance)}`,
    );
    expect(refused.recovery).toContain("Nothing was changed");

    const heartbeat = await until(
      "a heartbeat that says why",
      () => {
        const last = latest();
        return last?.upgrade.state === "recovery-required" && last;
      },
      5,
    );
    expect(heartbeat.upgrade.journal).toContain("backup target refused");
    expect(heartbeat.upgrade.journal).toContain(otherInstance);

    // Nothing was touched: Flux, the server (never scaled), the database (no snapshot anywhere),
    // and no backup Job, only the target check.
    expect(pinned()).toBe(from.digest);
    const after = server();
    expect(after?.metadata.generation).toBe(before?.metadata.generation);
    expect(after?.spec.replicas).toBe(before?.spec.replicas);
    const jobs = kubectl("-n", SYSTEM, "get", "jobs", "-o", "name");
    expect(jobs).toContain("openbot-backup-target-");
    expect(
      jobs.split("\n").filter((name) => /\/openbot-backup-\d/.test(name)),
    ).toEqual([]);
    expect(agentSnapshots(otherInstance)).toEqual([]);
    expect(agentSnapshots(productInstance)).toEqual([]);

    // It stays refused: a minute later still nothing more has run.
    await Bun.sleep(90_000);
    expect(pinned()).toBe(from.digest);
    expect(latest()?.upgrade.state).toBe("recovery-required");
  });

  test("values pointed at the product's instance: confirmed, snapshotted, then upgraded", async () => {
    await installAgent(productInstance);
    kubectl(
      "-n",
      SYSTEM,
      "patch",
      "configmap",
      "openbot-agent-state",
      "--type=json",
      "-p",
      '[{"op":"remove","path":"/data/journal.json"}]',
    );
    await until(
      `${to.version} installed and verified`,
      () => {
        const last = latest();
        return (
          last?.openbot.version === to.version && last.upgrade.state === "idle"
        );
      },
      60,
    );
    expect(pinned()).toBe(to.digest);
    const accepted = journal();
    expect(accepted.phase).toBe("accepted");
    expect(accepted.backupReference).toMatch(/^openbot-/);
    // The snapshot is of the product's instance, and RDS says it is available.
    const snapshots = agentSnapshots(productInstance);
    expect(snapshots.map((snapshot) => snapshot.DBSnapshotIdentifier)).toEqual([
      accepted.backupReference,
    ]);
    expect(snapshots[0]?.Status).toBe("available");
    expect(agentSnapshots(otherInstance)).toEqual([]);
    const logs = kubectl(
      "-n",
      SYSTEM,
      "logs",
      "deployment/openbot-agent",
      "--tail=400",
    );
    expect(logs).toContain("backup target confirmed");
  });
});
