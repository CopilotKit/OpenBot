/**
 * The management agent end to end, on a real cluster: the `openbot-agent` chart installs the
 * agent image and Flux, the agent talks to a real HTTPS management service over mutual TLS (a test
 * CA, the contract's strict schemas, Ed25519-signed commands), and moves a real openbot-bundle
 * between two real release builds:
 *
 *  1. first install from an empty namespace, of a build whose image does not exist: Flux fails it,
 *     recovery-required; a person clears it and the desired version moves to the real first
 *     build; the agent waits for the window, then installs that build (no backup: nothing was ever
 *     accepted, so there is no data yet) and /release reports it;
 *  2. a new desired version outside the maintenance window waits, with Flux left where it was;
 *  3. inside the window: quiesce, a backup Job (backup.kind=command, pg_dump of the bundle's real
 *     PostgreSQL, verified with pg_restore) that finishes before Flux is pinned to the new chart
 *     digest, then verification through /release;
 *  4. a signed rollback is refused because the release's policy says restore-backup;
 *  5. a release whose image does not exist: backup, Flux fails the upgrade, recovery-required;
 *     then, as a person recovers (journal.json removed, the desired version set back to the
 *     accepted release), the agent pins Flux back to the accepted chart, restarts every workload
 *     of the release so none keeps the old database server's address, and verifies it.
 *
 * Opt-in, because it needs a cluster it may write to and the release builds. On a kind cluster
 * with a plain-HTTP registry on the kind network:
 *
 *   OPENBOT_AGENT_E2E_KUBECONFIG=~/.kube/config      cluster to use (namespaces openbot-system, openbot)
 *   OPENBOT_AGENT_E2E_CHART=/path/to/charts/openbot-agent
 *   OPENBOT_AGENT_E2E_IMAGE=openbot-management-agent:e2e   loaded into the cluster
 *   OPENBOT_AGENT_E2E_RELEASES=/path    with <version>/openbot-bundle-*.tgz and <version>.json manifests
 *   OPENBOT_AGENT_E2E_FROM=v1.1.0  OPENBOT_AGENT_E2E_TO=v1.1.1-rc.1
 *   OPENBOT_AGENT_E2E_PUSH=localhost:5001     registry as this machine reaches it
 *   OPENBOT_AGENT_E2E_PULL=kind-registry:5000 the same registry as the cluster reaches it
 *   OPENBOT_AGENT_E2E_HOST=172.18.0.1         this machine as the cluster reaches it
 *   OPENBOT_AGENT_E2E_VALUES=/path/values.yaml  the bundle's own values (licence etc.), never committed
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
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const installId = "0b7f4f2e-3a49-4f61-9d2c-6c1d5a7e8f90";
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
const json = <T>(...args: string[]) =>
  JSON.parse(kubectl(...args, "-o", "json")) as T;

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
function push(
  version: string,
  releases = env.OPENBOT_AGENT_E2E_RELEASES ?? "",
): Build {
  const directory = join(releases, version);
  const chart = readdirSync(directory).find(
    (file) => file.startsWith("openbot-bundle-") && file.endsWith(".tgz"),
  );
  if (!chart) throw new Error(`no bundle chart in ${directory}`);
  // helm push names the digest on stderr.
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
  const output = `${pushed.stdout}${pushed.stderr}`;
  const digest = output.match(/Digest:\s*(sha256:[0-9a-f]{64})/)?.[1];
  if (!digest) throw new Error(`helm push printed no digest: ${output}`);
  return {
    version,
    manifest: readFileSync(join(releases, `${version}.json`), "utf8"),
    digest,
  };
}

/** The image digest every broken build names, which no registry has. */
const MISSING_IMAGE = `sha256:${"0123456789abcdef".repeat(4)}`;

/**
 * A release whose image does not exist: `build`'s bundle under another chart version (so another
 * chart digest), and a manifest that names an image digest no registry has. `edit` adjusts the
 * manifest further (its upgrade path, say).
 */
function brokenBuild(
  build: Build,
  directory: string,
  edit: (manifest: {
    upgrade: { fromVersions: string[] };
    compatibility: { database: { from: string[]; to: string } };
  }) => void = () => {},
): Build {
  const base = join(directory, `broken-${build.version}`);
  const version = `${build.version}-broken`;
  const source = join(base, "source");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(base, version), { recursive: true });
  const buildDirectory = join(
    env.OPENBOT_AGENT_E2E_RELEASES ?? "",
    build.version,
  );
  const buildChart = readdirSync(buildDirectory).find(
    (file) => file.startsWith("openbot-bundle-") && file.endsWith(".tgz"),
  );
  sh("tar", ["-xzf", join(buildDirectory, buildChart ?? ""), "-C", source]);
  const chartYaml = join(source, "openbot-bundle", "Chart.yaml");
  writeFileSync(
    chartYaml,
    readFileSync(chartYaml, "utf8").replace(
      /^version:\s*"?([^"\s]+)"?\s*$/m,
      "version: $1-broken",
    ),
  );
  sh("helm", [
    "package",
    join(source, "openbot-bundle"),
    "--destination",
    join(base, version),
  ]);
  const manifest = JSON.parse(build.manifest);
  manifest.version = version;
  for (const image of Object.values(
    manifest.artifacts.images as Record<string, { reference: string }>,
  ))
    image.reference = image.reference.replace(
      /@sha256:[0-9a-f]{64}$/,
      `@${MISSING_IMAGE}`,
    );
  edit(manifest);
  writeFileSync(join(base, `${version}.json`), JSON.stringify(manifest));
  const broken = push(version, base);
  expect(broken.digest).not.toBe(build.digest);
  return broken;
}

const run = kubeconfig ? describe : describe.skip;
let pki: TestPki;
let service: FakeManagementService;
let from: Build;
let to: Build;
let fullDatabaseUrl = "";

async function desire(build: Build) {
  const charts = {
    openbot: {
      ref: `oci://${env.OPENBOT_AGENT_E2E_PULL}/charts/openbot`,
      digest: build.digest,
    },
    bundle: {
      ref: `oci://${env.OPENBOT_AGENT_E2E_PULL}/charts/openbot-bundle`,
      digest: build.digest,
    },
  };
  service.desired = {
    version: build.version,
    releaseManifestSha256: await releaseManifestDigest(build.manifest),
    releaseManifest: build.manifest,
    charts,
  };
}
const latest = () => service.heartbeats.at(-1);
/** Seconds between the agent's heartbeats here, so each step it waits on comes round sooner than
 * the minute a real install uses. */
const HEARTBEAT_SECONDS = 5;
/** Waits for `count` more heartbeats than have arrived so far: that many full agent cycles. */
async function moreHeartbeats(count: number) {
  const seen = service.heartbeats.length;
  await until(
    `${count} more heartbeats`,
    () => service.heartbeats.length >= seen + count,
    10,
  );
}
const agentState = () =>
  json<{ data: Record<string, string> }>(
    "-n",
    SYSTEM,
    "get",
    "configmap",
    "openbot-agent-state",
  ).data;
const agentJournal = () => JSON.parse(agentState()["journal.json"] ?? "{}");
const backupJobs = () =>
  kubectl("-n", SYSTEM, "get", "jobs", "-o", "name")
    .split("\n")
    .filter((name) => name.includes("openbot-backup-"));
/** How long Flux gives a product install or upgrade, through the agent chart's values. */
const productTimeout = (value: string) =>
  shAsync("helm", [
    "upgrade",
    "openbot-agent",
    env.OPENBOT_AGENT_E2E_CHART ?? "",
    "-n",
    SYSTEM,
    "--reuse-values",
    "--set",
    `product.timeout=${value}`,
  ]);
/** What a person does to clear recovery-required, as the journal says: removes journal.json. */
const clearJournal = () =>
  kubectl(
    "-n",
    SYSTEM,
    "patch",
    "configmap",
    "openbot-agent-state",
    "--type=json",
    "-p",
    JSON.stringify([{ op: "remove", path: "/data/journal.json" }]),
  );
const pinned = () =>
  json<{ spec: { ref?: { digest?: string } } }>(
    "-n",
    SYSTEM,
    "get",
    "ocirepositories.source.toolkit.fluxcd.io",
    "openbot",
  ).spec.ref?.digest;

run("management agent on a real cluster", () => {
  beforeAll(async () => {
    const host = env.OPENBOT_AGENT_E2E_HOST ?? "";
    pki = makePki(installId, [host]);
    service = new FakeManagementService(pki, installId);
    const port = await service.start(0, "0.0.0.0");
    from = push(env.OPENBOT_AGENT_E2E_FROM ?? "v1.1.0");
    to = push(env.OPENBOT_AGENT_E2E_TO ?? "v1.1.1-rc.1");
    expect(from.digest).not.toBe(to.digest);

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
    // Filled in once the bundle has made its database; the backup Job reads it.
    secret("openbot-backup-db", SYSTEM, { DATABASE_URL: "" });

    const [repository, tag] = (env.OPENBOT_AGENT_E2E_IMAGE ?? "").split(":");
    const values = {
      installId,
      // The agent's own release, which runs upgrades with Flux beside it.
      managedUpgrades: true,
      commandPublicKey: service.publicKey,
      cloud: "other",
      heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
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
        // So the failed first install fails in minutes; the first test puts 20 minutes back.
        timeout: "4m",
      },
      backup: {
        kind: "command",
        timeoutSeconds: 900,
        command: {
          image: "postgres:18",
          command: [
            "sh",
            "-c",
            'set -eu; f=/tmp/$BACKUP_ID.dump; pg_dump --format=custom --file="$f" "$DATABASE_URL"; n=$(pg_restore --list "$f" | grep -c "TABLE DATA"); [ "$n" -gt 0 ]; echo "backup $BACKUP_ID verified: $n tables"',
          ],
          envFrom: [{ secretRef: { name: "openbot-backup-db" } }],
        },
      },
      agent: { image: { repository, tag } },
    };
    const file = join(pki.directory, "agent-values.json");
    writeFileSync(file, JSON.stringify(values));
    // Asynchronously, so the management service in this process keeps answering the agent. No
    // `--wait`: the support-bundle volume binds only when a bundle Job first uses it.
    await shAsync("helm", [
      "upgrade",
      "--install",
      "openbot-agent",
      env.OPENBOT_AGENT_E2E_CHART ?? "",
      "-n",
      SYSTEM,
      "--values",
      file,
    ]);
    await shAsync("kubectl", [
      "-n",
      SYSTEM,
      "rollout",
      "status",
      "deployment/openbot-agent",
      "--timeout=5m",
    ]);
  });

  afterAll(() => {
    service?.stop();
    if (pki) rmSync(pki.directory, { recursive: true, force: true });
  });

  test("a failed first install, once a person clears it, installs the build named next", async () => {
    // Outside any window: a first install changes no existing data, so it does not wait.
    const outside = {
      weekday: (new Date().getUTCDay() + 3) % 7,
      startUtc: "00:00",
      hours: 4,
    };
    service.window = outside;
    const broken = brokenBuild(from, pki.directory);
    await desire(broken);
    await until(
      "the agent's first heartbeat",
      () => service.heartbeats.length > 0,
      5,
    );
    const failed = await until(
      "the failed first install journaled as recovery-required",
      () => {
        const entry = agentJournal();
        return (
          entry.toVersion === broken.version &&
          entry.phase === "recovery-required" &&
          entry
        );
      },
      20,
    );
    expect(failed.fromVersion).toBe("none");
    await until(
      "recovery-required in the heartbeat",
      () => latest()?.upgrade.state === "recovery-required",
      5,
    );
    // Left as it failed: Flux on the failed chart and the release's server in the namespace, but no
    // server that answers /release, and no release accepted.
    expect(pinned()).toBe(broken.digest);
    expect(
      kubectl(
        "-n",
        PRODUCT,
        "get",
        "deployment",
        "-l",
        "app.kubernetes.io/instance=openbot,app.kubernetes.io/component=server",
        "-o",
        "name",
      ).trim(),
    ).not.toBe("");
    expect(
      JSON.parse(agentState()["state.json"] ?? "{}").accepted ?? null,
    ).toBeNull();
    await productTimeout("20m");

    // A person clears it and the desired version moves to the real first build. Outside the window
    // the agent says it waits for it, and leaves Flux where it is.
    clearJournal();
    await desire(from);
    await until(
      "waiting for the window to install the first build",
      () => {
        const last = latest();
        return (
          last?.upgrade.state === "waiting-window" &&
          last.upgrade.targetVersion === from.version
        );
      },
      5,
    );
    expect(pinned()).toBe(broken.digest);

    // Inside the window it installs that build, with no backup, and /release reports it.
    service.window = { weekday: 0, startUtc: "00:00", hours: 168 };
    const heartbeat = await until(
      `${from.version} installed and verified`,
      () => {
        const last = latest();
        return (
          last?.openbot.version === from.version &&
          last.upgrade.state === "idle" &&
          last
        );
      },
      30,
    );
    expect(heartbeat.flux.helmReleases[0]?.ready).toBe(true);
    expect(pinned()).toBe(from.digest);
    const installed = agentJournal();
    expect(installed.phase).toBe("accepted");
    expect(installed.fromVersion).toBe("none");
    expect(installed.toVersion).toBe(from.version);
    expect(installed.backupReference).toBe("none");
    expect(backupJobs()).toEqual([]);
    const state = JSON.parse(agentState()["state.json"] ?? "{}");
    expect(state.accepted.version).toBe(from.version);
    expect(state.accepted.digest).toBe(from.digest);
    expect(state.firstInstall).toBeNull();
    // No pod is left on the missing image.
    expect(kubectl("-n", PRODUCT, "get", "pods", "-o", "json")).not.toContain(
      MISSING_IMAGE,
    );
    expect(service.refused).toEqual([]);
    // The next test starts outside the window.
    service.window = outside;
  });

  test("waits outside the window and leaves Flux where it is", async () => {
    // Now the bundle's database exists: hand its URL to the backup Job.
    const secrets = json<{
      items: { metadata: { name: string }; data?: Record<string, string> }[];
    }>(
      "-n",
      PRODUCT,
      "get",
      "secrets",
      "-l",
      "app.kubernetes.io/component=openbot-database",
    ).items;
    const encoded = secrets
      .map((item) => item.data?.["database-url"])
      .find(Boolean);
    expect(encoded).toBeTruthy();
    // As the bundle writes it: the short Service name, which the backup Job in the agent's
    // namespace cannot resolve. The first backup fails on it, on purpose.
    kubectl(
      "-n",
      SYSTEM,
      "patch",
      "secret",
      "openbot-backup-db",
      "--type=merge",
      "-p",
      JSON.stringify({ data: { DATABASE_URL: encoded } }),
    );
    // What a working backup needs: the full Service name, and a role that bypasses row-level
    // security. OpenBot's tables FORCE it, so pg_dump as the owner refuses; the server's
    // superuser does not.
    const admin = json<{ data: Record<string, string> }>(
      "-n",
      PRODUCT,
      "get",
      "secret",
      "openbot-postgresql",
    ).data["postgres-password"];
    const database = new URL(
      Buffer.from(encoded ?? "", "base64").toString("utf8"),
    ).pathname.slice(1);
    fullDatabaseUrl = Buffer.from(
      `postgresql://postgres:${encodeURIComponent(Buffer.from(admin ?? "", "base64").toString("utf8"))}@openbot-postgresql.${PRODUCT}.svc.cluster.local:5432/${database}`,
    ).toString("base64");

    await desire(to);
    await until(
      "waiting-window",
      () => {
        const last = latest();
        return (
          last?.upgrade.state === "waiting-window" &&
          last.upgrade.targetVersion === to.version
        );
      },
      5,
    );
    expect(pinned()).toBe(from.digest);
    expect(kubectl("-n", SYSTEM, "get", "jobs", "-o", "name")).not.toContain(
      "openbot-backup-",
    );
  });

  test("a failed backup puts the release back as it was and is not retried at once", async () => {
    service.window = { weekday: 0, startUtc: "00:00", hours: 168 };
    const journal = () =>
      JSON.parse(
        json<{ data: Record<string, string> }>(
          "-n",
          SYSTEM,
          "get",
          "configmap",
          "openbot-agent-state",
        ).data["journal.json"] ?? "{}",
      );
    const failed = await until(
      "the promotion undone after the backup failed",
      () => {
        const entry = journal();
        return (
          entry.toVersion === to.version && entry.phase === "failed" && entry
        );
      },
      10,
    );
    expect(failed.error).toContain("failed");
    expect(failed.databaseMayHaveChanged).toBe(false);
    // Writes are back: the server at its replicas, the CronJobs it suspended running again.
    await until(
      "the server back at its replicas",
      () => {
        const server = json<{
          items: {
            spec: { replicas?: number };
            status: { readyReplicas?: number };
          }[];
        }>(
          "-n",
          PRODUCT,
          "get",
          "deployment",
          "-l",
          "app.kubernetes.io/instance=openbot,app.kubernetes.io/component=server",
        ).items[0];
        return (
          server?.spec.replicas === failed.previousReplicas &&
          server.status.readyReplicas === failed.previousReplicas
        );
      },
      10,
    );
    const cronJobs = json<{
      items: { metadata: { name: string }; spec: { suspend?: boolean } }[];
    }>("-n", PRODUCT, "get", "cronjob").items;
    for (const job of failed.pausedCronJobs ?? [])
      if (!job.wasSuspended)
        expect(
          cronJobs.find((entry) => entry.metadata.name === job.name)?.spec
            .suspend ?? false,
        ).toBe(false);
    expect(pinned()).toBe(from.digest);
    // Three more heartbeats, and still one backup attempt: the product is not quiesced every minute.
    // Each heartbeat is followed by that cycle's reconcile, so four more heartbeats mean three
    // whole cycles, each of which decided against trying again.
    await moreHeartbeats(4);
    const backups = kubectl("-n", SYSTEM, "get", "jobs", "-o", "name")
      .split("\n")
      .filter((name) => name.includes("openbot-backup-"));
    expect(backups).toHaveLength(1);
    expect(latest()?.upgrade.state).toBe("idle");
    expect(latest()?.upgrade.journal ?? "").toContain("retried");

    // A person fixes the backup's database address; a restarted agent tries again straight away.
    kubectl(
      "-n",
      SYSTEM,
      "patch",
      "secret",
      "openbot-backup-db",
      "--type=merge",
      "-p",
      JSON.stringify({ data: { DATABASE_URL: fullDatabaseUrl } }),
    );
    kubectl("-n", SYSTEM, "rollout", "restart", "deployment/openbot-agent");
  });

  test("inside the window: backs up first, then upgrades and verifies", async () => {
    service.window = { weekday: 0, startUtc: "00:00", hours: 168 };
    await until(
      `${to.version} installed and verified`,
      () => {
        const last = latest();
        return (
          last?.openbot.version === to.version && last.upgrade.state === "idle"
        );
      },
      40,
    );
    expect(pinned()).toBe(to.digest);

    const state = json<{ data: Record<string, string> }>(
      "-n",
      SYSTEM,
      "get",
      "configmap",
      "openbot-agent-state",
    ).data;
    const journal = JSON.parse(state["journal.json"] ?? "{}");
    expect(journal.phase).toBe("accepted");
    expect(journal.fromVersion).toBe(from.version);
    expect(journal.toVersion).toBe(to.version);
    expect(journal.backupReference).toMatch(/^openbot-/);

    const job = json<{
      status: { succeeded?: number; completionTime?: string };
    }>(
      "-n",
      SYSTEM,
      "get",
      "job",
      journal.backupReference.replace(/^openbot-/, "openbot-backup-"),
    );
    expect(job.status.succeeded).toBe(1);
    const logs = kubectl(
      "-n",
      SYSTEM,
      "logs",
      `job/${journal.backupReference.replace(/^openbot-/, "openbot-backup-")}`,
    );
    expect(logs).toMatch(/verified: \d+ tables/);

    // The backup finished before Flux applied the new release.
    const release = json<{
      status: {
        history: {
          chartVersion?: string;
          digest?: string;
          lastDeployed?: string;
          firstDeployed?: string;
        }[];
      };
    }>("-n", SYSTEM, "get", "helmreleases.helm.toolkit.fluxcd.io", "openbot");
    const upgraded = release.status.history[0];
    expect(Date.parse(job.status.completionTime ?? "")).toBeLessThan(
      Date.parse(upgraded?.lastDeployed ?? upgraded?.firstDeployed ?? ""),
    );

    // The running server is the new release's image, by digest.
    const manifest = JSON.parse(to.manifest);
    const digest = manifest.artifacts.images.openbot.reference.split("@")[1];
    const deployments = json<{
      items: {
        spec: {
          template: { spec: { containers: { name: string; image: string }[] } };
        };
      }[];
    }>(
      "-n",
      PRODUCT,
      "get",
      "deployment",
      "-l",
      "app.kubernetes.io/instance=openbot,app.kubernetes.io/component=server",
    ).items;
    expect(
      deployments[0]?.spec.template.spec.containers.find(
        (c) => c.name === "server",
      )?.image,
    ).toEndWith(`@${digest}`);
  });

  test("a signed rollback is refused when the release policy says restore-backup", async () => {
    expect(JSON.parse(to.manifest).upgrade.recovery).toBe("restore-backup");
    const command = await service.command({
      id: `rollback-${Date.now()}`,
      kind: "rollback",
      args: {},
    });
    const result = await until(
      "the rollback's result",
      () => service.results.find((entry) => entry.commandId === command.id),
      5,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("policy: restore-backup needs a person");
    expect(pinned()).toBe(to.digest);
  });

  test("after a failed upgrade and a person's recovery, Flux is pinned back to the accepted release", async () => {
    service.window = { weekday: 0, startUtc: "00:00", hours: 168 };
    // A release whose image does not exist, upgradable from the accepted one.
    const broken = brokenBuild(to, pki.directory, (manifest) => {
      manifest.upgrade.fromVersions = [to.version];
      manifest.compatibility.database.from = [
        manifest.compatibility.database.to,
      ];
    });
    const version = broken.version;
    const missing = MISSING_IMAGE;

    // So the failed upgrade fails in 90 seconds rather than after the bundle's 20 minutes. The
    // return to the accepted release runs under it too: its images are already on the node, so it
    // is ready well inside that.
    const timeout = productTimeout;
    await timeout("90s");

    const state = agentState;
    const journal = agentJournal;
    const backups = backupJobs;
    const backupsBefore = backups().length;
    const history = () =>
      JSON.parse(
        sh("helm", ["history", "openbot", "-n", PRODUCT, "-o", "json"]),
      ) as { revision: number; chart: string }[];
    // The failed first install left broken revisions of its own; only this upgrade's count here.
    const revisionBefore = Math.max(
      ...history().map((entry) => entry.revision),
    );

    await desire(broken);
    const failed = await until(
      "the failed upgrade journaled as recovery-required",
      () => {
        const entry = journal();
        return (
          entry.toVersion === version &&
          entry.phase === "recovery-required" &&
          entry
        );
      },
      30,
    );
    expect(failed.databaseMayHaveChanged).toBe(true);
    expect(failed.backupReference).toMatch(/^openbot-/);
    expect(backups()).toHaveLength(backupsBefore + 1);
    await until(
      "recovery-required in the heartbeat",
      () => latest()?.upgrade.state === "recovery-required",
      5,
    );
    // Flux attempted the failed chart once. A failure-count reset sent with the new digest made
    // helm-controller upgrade to it a second time straight after the first attempt failed. A few
    // more heartbeats first, so a second attempt has had the time to start before it is counted.
    await moreHeartbeats(3);
    const brokenAttempts = () =>
      history().filter(
        (entry) =>
          entry.revision > revisionBefore && entry.chart.includes("-broken"),
      );
    expect(brokenAttempts()).toHaveLength(1);
    // Left as it failed: Flux on the failed chart, the pins naming the missing image.
    expect(pinned()).toBe(broken.digest);
    expect(
      kubectl(
        "-n",
        SYSTEM,
        "get",
        "configmap",
        "openbot-agent-pins",
        "-o",
        "json",
      ),
    ).toContain(missing);

    // The person recovers as the journal says. The failed release's image never ran, so the
    // database is the one the accepted release left and restoring the backup changes nothing here.
    // The desired version goes back to the accepted release, then journal.json is removed.
    const recoveredAt = Date.now();
    await desire(to);
    kubectl(
      "-n",
      SYSTEM,
      "patch",
      "configmap",
      "openbot-agent-state",
      "--type=json",
      "-p",
      JSON.stringify([{ op: "remove", path: "/data/journal.json" }]),
    );

    await until(
      `Flux pinned back to ${to.version}, verified`,
      () => {
        const last = latest();
        return (
          pinned() === to.digest &&
          journal().phase === "accepted" &&
          last?.openbot.version === to.version &&
          last.upgrade.state === "idle" &&
          last.flux.helmReleases[0]?.ready === true
        );
      },
      30,
    );
    const restored = journal();
    expect(restored.fromVersion).toBe(`chart ${broken.digest}`);
    expect(restored.toVersion).toBe(to.version);
    expect(restored.backupReference).toBe("none");
    // Returning to the accepted release takes no second backup, and the failed chart was never
    // tried again on the way.
    expect(backups()).toHaveLength(backupsBefore + 1);
    expect(brokenAttempts()).toHaveLength(1);

    const release = json<{
      status: {
        lastAttemptedRevisionDigest?: string;
        conditions?: { type: string; status: string }[];
      };
    }>("-n", SYSTEM, "get", "helmreleases.helm.toolkit.fluxcd.io", "openbot");
    expect(release.status.lastAttemptedRevisionDigest).toBe(to.digest);
    expect(
      release.status.conditions?.find((c) => c.type === "Ready")?.status,
    ).toBe("True");
    const accepted = JSON.parse(state()["state.json"] ?? "{}");
    expect(accepted.accepted.version).toBe(to.version);
    expect(accepted.accepted.digest).toBe(to.digest);

    // Every workload of the release was restarted after the recovery. A restore repoints the
    // release at a new database server; the upgrade rewrites the connection Secrets, but a
    // workload whose pod template does not change (Intelligence's) would keep the old server's
    // address it read at start and go on writing there.
    const workloads = json<{
      items: {
        kind: string;
        metadata: { name: string };
        spec: {
          template: { metadata: { annotations?: Record<string, string> } };
        };
      }[];
    }>(
      "-n",
      PRODUCT,
      "get",
      "deployment,statefulset",
      "-l",
      "app.kubernetes.io/instance=openbot",
    ).items;
    expect(workloads.length).toBeGreaterThan(1);
    // One minute of slack for the cluster's clock against this machine's.
    const restarted = (annotations?: Record<string, string>) =>
      Date.parse(annotations?.["kubectl.kubernetes.io/restartedAt"] ?? "") >=
      recoveredAt - 60_000;
    expect(
      workloads
        .filter((w) => !restarted(w.spec.template.metadata.annotations))
        .map((w) => `${w.kind}/${w.metadata.name}`),
    ).toEqual([]);

    // The server runs the accepted release's image again, with its replicas back.
    const image = JSON.parse(to.manifest).artifacts.images.openbot.reference;
    const server = json<{
      items: {
        spec: {
          template: { spec: { containers: { name: string; image: string }[] } };
        };
        status: { readyReplicas?: number };
      }[];
    }>(
      "-n",
      PRODUCT,
      "get",
      "deployment",
      "-l",
      "app.kubernetes.io/instance=openbot,app.kubernetes.io/component=server",
    ).items[0];
    expect(
      server?.spec.template.spec.containers.find((c) => c.name === "server")
        ?.image,
    ).toEndWith(`@${image.split("@")[1]}`);
    expect(server?.status.readyReplicas ?? 0).toBeGreaterThan(0);
    // No pod is left on the missing image: the StatefulSet pod the failed release started was
    // deleted so the StatefulSet could roll back (Kubernetes' forced rollback).
    expect(kubectl("-n", PRODUCT, "get", "pods", "-o", "json")).not.toContain(
      missing,
    );

    await timeout("20m");
  });
});
