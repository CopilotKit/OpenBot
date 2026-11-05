/**
 * Kubernetes promotion against this repository's real chart, rendered by real Helm.
 *
 * The cluster is a small in-memory one, because a test cannot pull the release image into a real
 * one. What it does with a `helm upgrade` is what a kind cluster was measured doing (Helm 4.2,
 * Kubernetes 1.3x): the upgrade renders the real packaged chart with the exact values files the
 * promotion passes, and then
 *  - client-side apply (every Helm 3 release, and Helm 4 releases installed with it) sets each
 *    field the rendered manifest declares and leaves every field it does not declare as it is, so
 *    a CronJob that `kubectl patch` suspended stays suspended unless the chart declares `suspend`;
 *  - server-side apply refuses, with a field-manager conflict, to set a declared field that
 *    `kubectl patch` or `kubectl scale` last wrote, unless the upgrade passes `--force-conflicts`;
 *  - `helm get values -o json` prints `null` for a release installed with no values.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import {
  type KubernetesPromotionOptions,
  promoteKubernetes,
} from "../scripts/promote-kubernetes";
import { type CommandRunner, runCommand } from "../scripts/update-local";
import targetFixture from "../shared/fixtures/releases/candidate.json";
import currentFixture from "../shared/fixtures/releases/installed.json";
import { parseReleaseManifest } from "../shared/release-manifest";

setDefaultTimeout(120_000);
const helm = Bun.which("helm") !== null;
const digest = `sha256:${"b".repeat(64)}`;
const mirror = "registry.internal/mirror/openbot";
const chartSource = join(import.meta.dir, "../charts/openbot");

type Values = Record<string, unknown>;
function merge(base: Values, overlay: Values): Values {
  const result: Values = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
        ? merge(existing as Values, value as Values)
        : value;
  }
  return result;
}

let work = "";
let chart = "";
let customerFiles: string[] = [];
beforeAll(async () => {
  if (!helm) return;
  work = mkdtempSync(join(tmpdir(), "openbot-promotion-helm-"));
  // The packaged chart is the artifact a release pins. Packaging needs the bundled PostgreSQL and
  // Intelligence subcharts in charts/, which `helm dependency build` fetches when this checkout has
  // not.
  cpSync(chartSource, join(work, "openbot"), { recursive: true });
  const vendored = existsSync(join(work, "openbot", "charts"))
    ? readdirSync(join(work, "openbot", "charts"))
    : [];
  if (
    !["postgresql-", "intelligence-"].every((prefix) =>
      vendored.some((name) => name.startsWith(prefix)),
    )
  )
    await runCommand(["helm", "dependency", "build", join(work, "openbot")], {
      cwd: work,
    });
  await runCommand(
    ["helm", "package", join(work, "openbot"), "--destination", work],
    { cwd: work },
  );
  chart = join(
    work,
    readdirSync(work).find((name) => name.endsWith(".tgz")) ?? "",
  );
  const secrets = join(work, "customer-secrets.yaml");
  writeFileSync(
    secrets,
    `secrets:\n  keyEncryptionKey: ${randomBytes(32).toString("base64")}\nroutines:\n  enabled: true\n`,
  );
  customerFiles = [join(chartSource, "ci/self-hosted-values.yaml"), secrets];
});

interface CronJob {
  suspend: boolean;
}
function render(text: string) {
  const documents = parseAllDocuments(text).map((document) => {
    if (document.errors.length) throw new Error("render is not valid YAML");
    return document.toJSON() as {
      kind?: string;
      metadata?: { name?: string; labels?: Record<string, string> };
      spec?: Record<string, unknown>;
    };
  });
  const server = documents.find(
    (document) =>
      document?.kind === "Deployment" &&
      document.metadata?.labels?.["app.kubernetes.io/component"] === "server",
  );
  const cronJobs = documents.filter((document) => document?.kind === "CronJob");
  return { server, cronJobs };
}

/** One cluster holding one installed release, installed with `--set` values on top of the
 * customer's files. */
async function cluster(options: {
  applyMethod: "csa" | "ssa";
  installSets: Values;
  backupFails?: boolean;
  upgradeFails?: boolean;
}) {
  const installed = merge(
    customerFiles.reduce<Values>(
      (values, path) =>
        merge(values, (parse(readFileSync(path, "utf8")) ?? {}) as Values),
      {},
    ),
    options.installSets,
  );
  const installValues = join(
    work,
    `installed-${randomBytes(4).toString("hex")}.json`,
  );
  writeFileSync(installValues, JSON.stringify(installed));
  const first = render(
    await runCommand(
      [
        "helm",
        "template",
        "openbot",
        chart,
        "--namespace",
        "customer",
        "--values",
        installValues,
      ],
      { cwd: work },
    ),
  );
  const serverSpec = first.server?.spec as {
    replicas?: number;
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: { containers: { name: string; image: string }[] };
    };
  };
  const state = {
    replicas: serverSpec.replicas ?? 1,
    template: structuredClone(serverSpec.template),
    cronJobs: new Map<string, CronJob>(),
    manifest: "",
    kubectlOwned: new Set<string>(),
    calls: [] as string[][],
  };
  for (const job of first.cronJobs)
    state.cronJobs.set(job.metadata?.name ?? "", {
      suspend: (job.spec?.suspend as boolean | undefined) ?? false,
    });
  // Something an operator made by hand with the release's label, and paused on purpose.
  state.cronJobs.set("openbot-operator-report", { suspend: true });
  const managed = new Set(
    first.cronJobs.map((job) => job.metadata?.name ?? ""),
  );
  const run: CommandRunner = async (command, commandOptions) => {
    state.calls.push([...command]);
    const [tool, verb] = command;
    if (tool === "helm" && verb === "get" && command[2] === "values")
      return Object.keys(options.installSets).length
        ? JSON.stringify(installed)
        : "null\n";
    if (tool === "helm" && verb === "version")
      return options.applyMethod === "ssa" ? "v4.2.0" : "v3.19.0";
    if (tool === "helm" && verb === "get" && command[2] === "metadata")
      return JSON.stringify({ applyMethod: options.applyMethod });
    if (tool === "helm" && verb === "get" && command[2] === "manifest")
      return state.manifest;
    if (tool === "helm" && verb === "upgrade") {
      if (options.upgradeFails)
        throw new Error("helm upgrade timed out waiting");
      const values = command.flatMap((part, index) =>
        part === "--values" ? ["--values", command[index + 1] ?? ""] : [],
      );
      const text = await runCommand(
        [
          "helm",
          "template",
          "openbot",
          chart,
          "--namespace",
          "customer",
          "--is-upgrade",
          ...values,
        ],
        commandOptions,
      );
      const target = render(text);
      const force = command.includes("--force-conflicts");
      const targetSpec = target.server?.spec as typeof serverSpec;
      if (options.applyMethod === "ssa" && !force) {
        for (const job of target.cronJobs)
          if (
            job.spec &&
            "suspend" in job.spec &&
            state.kubectlOwned.has(`cronjob/${job.metadata?.name}`)
          )
            throw new Error(
              `conflict with "kubectl-patch": .spec.suspend of ${job.metadata?.name}`,
            );
        if (
          targetSpec.replicas !== undefined &&
          state.kubectlOwned.has("deployment/replicas")
        )
          throw new Error('conflict with "kubectl": .spec.replicas');
      }
      if (targetSpec.replicas !== undefined) {
        state.replicas = targetSpec.replicas;
        state.kubectlOwned.delete("deployment/replicas");
      }
      state.template = structuredClone(targetSpec.template);
      for (const name of managed)
        if (!target.cronJobs.some((job) => job.metadata?.name === name))
          state.cronJobs.delete(name);
      for (const job of target.cronJobs) {
        const name = job.metadata?.name ?? "";
        const live = state.cronJobs.get(name) ?? { suspend: false };
        if (job.spec && "suspend" in job.spec) {
          live.suspend = job.spec.suspend as boolean;
          state.kubectlOwned.delete(`cronjob/${name}`);
        }
        state.cronJobs.set(name, live);
        managed.add(name);
      }
      state.manifest = text;
      return "";
    }
    if (
      tool === "kubectl" &&
      command.includes("get") &&
      command.includes("deployment")
    )
      return JSON.stringify({
        items: [
          {
            metadata: { name: "openbot-server" },
            spec: { replicas: state.replicas, template: state.template },
          },
        ],
      });
    if (
      tool === "kubectl" &&
      command.includes("get") &&
      command.includes("cronjob")
    )
      return JSON.stringify({
        items: [...state.cronJobs].map(([name, job]) => ({
          metadata: { name },
          spec: { suspend: job.suspend },
          status: {},
        })),
      });
    if (tool === "kubectl" && command.includes("patch")) {
      const name = command[command.indexOf("cronjob") + 1] ?? "";
      const job = state.cronJobs.get(name);
      if (!job) throw new Error(`cronjobs.batch "${name}" not found`);
      job.suspend = JSON.parse(command.at(-1) ?? "{}").spec.suspend;
      state.kubectlOwned.add(`cronjob/${name}`);
      return "";
    }
    if (tool === "kubectl" && command.includes("scale")) {
      state.replicas = Number(
        command.find((part) => part.startsWith("--replicas="))?.split("=")[1],
      );
      state.kubectlOwned.add("deployment/replicas");
      return "";
    }
    if (tool === "kubectl" && command.includes("exec")) {
      const image =
        state.template.spec.containers.find((c) => c.name === "server")
          ?.image ?? "";
      return JSON.stringify(
        image.endsWith(`@${digest}`)
          ? {
              version:
                state.template.metadata?.annotations?.["openbot.ai/release"],
              commit:
                state.template.metadata?.annotations?.[
                  "openbot.ai/source-commit"
                ],
              distributionId: "acme.openbot",
              repository: "acme/openbot",
              channel: "stable",
            }
          : {},
      );
    }
    if (command[0] === "customer-backup") {
      if (options.backupFails)
        throw new Error("backup could not reach the database");
      return "";
    }
    return "";
  };
  return { state, run };
}

function promotion(run: CommandRunner): KubernetesPromotionOptions {
  const current = parseReleaseManifest(structuredClone(currentFixture));
  const candidate = parseReleaseManifest(structuredClone(targetFixture));
  current.artifacts.images.openbot = {
    reference: `ghcr.io/acme/openbot@${digest}`,
  };
  candidate.artifacts.images.openbot = {
    reference: `ghcr.io/acme/openbot@${digest}`,
  };
  candidate.artifacts.chart = {
    version: "0.1.4",
    url: "https://github.com/acme/openbot/releases/download/v0.3.0/openbot.tgz",
    sha256: createHash("sha256").update(readFileSync(chart)).digest("hex"),
  };
  return {
    current,
    candidate,
    policy: {
      distributionId: "acme.openbot",
      repository: "acme/openbot",
      channel: "stable",
    },
    namespace: "customer",
    release: "openbot",
    chart,
    customerValues: customerFiles,
    outputDirectory: mkdtempSync(join(tmpdir(), "openbot-promotion-output-")),
    backupReference: "snapshot:verified-backup",
    backupCommand: ["customer-backup"],
    acknowledgeInterruption: true,
    timeoutSeconds: 120,
    run,
  };
}
/** As the previous promotion left the release: the accepted image pinned, plus a value somebody set
 * with `--set` at install that no customer file carries. */
const installSets = {
  server: { replicaCount: 3 },
  image: { repository: "ghcr.io/acme/openbot", tag: "v0.2.0", digest },
};
function journal(options: KubernetesPromotionOptions) {
  const path = join(options.outputDirectory, "promotion-journal.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
const serverImage = (state: Awaited<ReturnType<typeof cluster>>["state"]) =>
  state.template.spec.containers.find((c) => c.name === "server")?.image;

describe.skipIf(!helm)("Helm promotion of the real chart", () => {
  test.each(["csa", "ssa"] as const)(
    "a maintenance promotion (%s) puts every CronJob back exactly as it was",
    async (applyMethod) => {
      const { state, run } = await cluster({ applyMethod, installSets });
      const before = new Map(
        [...state.cronJobs].map(([name, job]) => [name, job.suspend]),
      );
      expect(before.get("openbot-attachments-culler")).toBe(false);
      expect(before.get("openbot-operator-report")).toBe(true);
      expect((await promoteKubernetes(promotion(run))).phase).toBe("accepted");
      for (const [name, suspended] of before)
        expect([name, state.cronJobs.get(name)?.suspend]).toEqual([
          name,
          suspended,
        ]);
      const upgrade =
        state.calls.find((c) => c[0] === "helm" && c[1] === "upgrade") ?? [];
      expect(upgrade.includes("--force-conflicts")).toBe(applyMethod === "ssa");
    },
  );

  test("a value set with --set at install survives the upgrade", async () => {
    const { state, run } = await cluster({ applyMethod: "csa", installSets });
    expect(state.replicas).toBe(3);
    expect((await promoteKubernetes(promotion(run))).phase).toBe("accepted");
    expect(state.replicas).toBe(3);
  });

  test("a registry mirror the customer installed with is kept, with the candidate's digest", async () => {
    const { state, run } = await cluster({
      applyMethod: "csa",
      installSets: {
        ...installSets,
        image: { ...installSets.image, repository: mirror },
      },
    });
    expect(serverImage(state)).toBe(`${mirror}:v0.2.0@${digest}`);
    expect((await promoteKubernetes(promotion(run))).phase).toBe("accepted");
    expect(serverImage(state)).toBe(`${mirror}:v0.3.0@${digest}`);
  });

  test("a rollback-compatible promotion that fails is left serving, never scaled to zero", async () => {
    const { state, run } = await cluster({
      applyMethod: "csa",
      installSets,
      upgradeFails: true,
    });
    const options = promotion(run);
    options.candidate.upgrade.requiresDowntime = false;
    await expect(promoteKubernetes(options)).rejects.toThrow("helm upgrade");
    expect(state.calls.some((c) => c.includes("scale"))).toBe(false);
    expect(state.replicas).toBe(3);
    expect(journal(options).phase).toBe("recovery-required");
  });

  test("a refusal before anything changed writes no journal and touches nothing", async () => {
    const { state, run } = await cluster({ applyMethod: "csa", installSets });
    const options = promotion(run);
    options.current.artifacts.images.openbot = {
      reference: `ghcr.io/acme/openbot@sha256:${"e".repeat(64)}`,
    };
    await expect(promoteKubernetes(options)).rejects.toThrow("does not match");
    expect(journal(options)).toBeUndefined();
    expect(
      state.calls.some((c) => c.includes("patch") || c.includes("scale")),
    ).toBe(false);
  });

  test("a failed backup puts the release back exactly and the next attempt can proceed", async () => {
    const failing = await cluster({
      applyMethod: "csa",
      installSets,
      backupFails: true,
    });
    const before = new Map(
      [...failing.state.cronJobs].map(([name, job]) => [name, job.suspend]),
    );
    const options = promotion(failing.run);
    await expect(promoteKubernetes(options)).rejects.toThrow("backup");
    expect(journal(options).phase).toBe("failed");
    expect(failing.state.replicas).toBe(3);
    for (const [name, suspended] of before)
      expect([name, failing.state.cronJobs.get(name)?.suspend]).toEqual([
        name,
        suspended,
      ]);
    const retry = await cluster({ applyMethod: "csa", installSets });
    expect(
      (await promoteKubernetes({ ...options, run: retry.run })).phase,
    ).toBe("accepted");
  });
});
