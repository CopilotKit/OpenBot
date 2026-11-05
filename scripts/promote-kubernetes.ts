/** Operator-owned, digest-pinned Helm promotion; never called by the running application. */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isMap, isScalar, isSeq, parse, parseAllDocuments } from "yaml";
import {
  parseReleaseManifest,
  planUpgrade,
  type ReleaseManifest,
  type UpgradePolicy,
} from "../shared/release-manifest";
import {
  atomicJson,
  type CommandRunner,
  RELEASE_FROM_INSIDE,
  runCommand,
} from "./update-local";

export interface KubernetesPromotionOptions {
  current: ReleaseManifest;
  candidate: ReleaseManifest;
  policy: UpgradePolicy;
  namespace: string;
  release: string;
  chart: string;
  customerValues: string[];
  outputDirectory: string;
  backupReference: string;
  /** Executable and arguments, invoked without a shell after write admission is stopped. */
  backupCommand?: string[];
  acknowledgeInterruption?: boolean;
  timeoutSeconds?: number;
  intelligenceCapabilities?: string[];
  run?: CommandRunner;
}
interface PromotionValues {
  image: { repository: string; tag: string; digest: string };
  commonAnnotations: Record<string, string>;
  server: { podAnnotations: Record<string, string> };
}
interface Deployment {
  metadata?: { name?: string };
  spec: {
    replicas?: number;
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: { containers: { name: string; image: string }[] };
    };
  };
}
interface DeploymentList {
  items: Deployment[];
}
interface CronJobList {
  items: {
    metadata: { name: string };
    spec: { suspend?: boolean };
    status?: { active?: { name: string }[] };
  }[];
}
interface PromotionJournal {
  operation: string;
  phase:
    | "prepared"
    | "quiescing"
    | "backing-up"
    | "promoting"
    | "verifying"
    | "accepted"
    | "failed"
    | "recovery-required";
  fromVersion: string;
  toVersion: string;
  namespace: string;
  release: string;
  backupReference: string;
  databaseMayHaveChanged: boolean;
  previousReplicas?: number;
  /** Every release CronJob as it was before quiescing. Only those with `wasSuspended: false` were
   * suspended by this operation, and only those are put back. */
  pausedCronJobs?: { name: string; wasSuspended: boolean }[];
  error?: string;
  recovery: string;
}
const DNS = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
function selectedImage(manifest: ReleaseManifest) {
  const image = manifest.artifacts.images.openbot;
  if (!image)
    throw new Error(
      "Kubernetes requires the monolithic 'openbot' image; the desktop server image does not contain every chart component",
    );
  return image.reference;
}
function imageParts(reference: string) {
  const [repository, digest] = reference.split("@");
  if (!repository || !digest)
    throw new Error("Expected a digest-pinned OpenBot image");
  // Repository names can carry a registry port; only a colon after the final slash is a tag.
  const tagPosition = repository.lastIndexOf(":");
  return {
    repository:
      tagPosition > repository.lastIndexOf("/")
        ? repository.slice(0, tagPosition)
        : repository,
    digest,
  };
}
async function requireRenderedMigration(
  options: KubernetesPromotionOptions,
  values: PromotionValues,
  previousValues: Record<string, unknown> | undefined,
) {
  const directory = mkdtempSync(join(tmpdir(), "openbot-migration-preflight-"));
  try {
    const file = join(directory, "release-values.json");
    atomicJson(file, values);
    const previous = join(directory, "previous-values.json");
    if (previousValues) atomicJson(previous, previousValues);
    const rendered = await (options.run ?? runCommand)(
      [
        "helm",
        "template",
        options.release,
        resolve(options.chart),
        "--namespace",
        options.namespace,
        "--is-upgrade",
        ...(previousValues ? ["--values", previous] : []),
        ...options.customerValues.flatMap((path) => [
          "--values",
          resolve(path),
        ]),
        "--values",
        file,
      ],
      { cwd: directory, timeoutMs: (options.timeoutSeconds ?? 300) * 1000 },
    );
    const expected = {
      repository: values.image.repository,
      digest: values.image.digest,
    };
    const guarded = parseAllDocuments(rendered).some((document) => {
      if (document.errors.length)
        throw new Error(
          "Target chart rendered invalid YAML during migration preflight",
        );
      const hook = document.getIn(["metadata", "annotations", "helm.sh/hook"]);
      if (
        document.get("kind") !== "Job" ||
        typeof hook !== "string" ||
        !hook
          .split(",")
          .map((part) => part.trim())
          .includes("pre-upgrade") ||
        document.getIn([
          "metadata",
          "labels",
          "app.kubernetes.io/component",
        ]) !== "migrations"
      )
        return false;
      const containers = document.getIn([
        "spec",
        "template",
        "spec",
        "containers",
      ]);
      return (
        isSeq(containers) &&
        containers.items.some((container) => {
          if (
            !isMap(container) ||
            container.get("workingDir") !== "/app/server"
          )
            return false;
          const image = container.get("image");
          const command = container.get("command");
          if (typeof image !== "string" || !isSeq(command)) return false;
          const actual = imageParts(image);
          const invocation = command.items
            .map((part) =>
              isScalar(part) && typeof part.value === "string"
                ? part.value
                : "",
            )
            .join("\n");
          return (
            actual.repository === expected.repository &&
            actual.digest === expected.digest &&
            /(?:^|\n)\s*exec\s+(?:\/usr\/local\/bin\/)?bun\s+scripts\/migrate\.ts(?:\s|$)/.test(
              invocation,
            )
          );
        })
      );
    });
    if (!guarded)
      throw new Error(
        "Required database transition has no guarded pre-upgrade migration Job in the effective target chart; migrations must remain enabled",
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** The image repository the customer chose, if any: a registry mirror set in a values file, or
 * one set at install (`--set`) that `helm get values` still reports. A repository the previous
 * promotion pinned from the accepted manifest is this tool's own choice, not the customer's. The
 * digest stays pinned whichever registry serves it, so a mirror cannot change the bytes. */
function customerRepository(
  options: KubernetesPromotionOptions,
  current: ReleaseManifest,
  previousValues: Record<string, unknown> | undefined,
) {
  const repositoryOf = (values: unknown) => {
    const image =
      values && typeof values === "object"
        ? (values as { image?: unknown }).image
        : undefined;
    const repository =
      image && typeof image === "object"
        ? (image as { repository?: unknown }).repository
        : undefined;
    return typeof repository === "string" && repository.trim()
      ? repository.trim()
      : undefined;
  };
  let chosen = repositoryOf(previousValues);
  if (chosen === imageParts(selectedImage(current)).repository)
    chosen = undefined;
  for (const path of options.customerValues) {
    const value = repositoryOf(parse(readFileSync(path, "utf8")));
    if (value) chosen = value;
  }
  return chosen;
}
/** `previousValues` is what `helm get values` reports for the live release. Plan and check read no
 * cluster state, so they leave it out; apply reads it first and plans with it. */
export async function planKubernetesPromotion(
  options: KubernetesPromotionOptions,
  previousValues?: Record<string, unknown>,
) {
  const current = parseReleaseManifest(options.current);
  const candidate = parseReleaseManifest(options.candidate);
  const common = planUpgrade(
    {
      manifest: current,
      sourceKind: "stock",
      launcherApi: 1,
      configSchema: current.compatibility.configSchema,
      extensionApi: current.compatibility.extensionApi,
      intelligenceCapabilities:
        options.intelligenceCapabilities ??
        current.compatibility.intelligenceCapabilities,
    },
    candidate,
    options.policy,
  );
  const reasons = [...common.reasons];
  let image = { repository: "", tag: candidate.version, digest: "" };
  let mirror: string | undefined;
  try {
    image = { ...imageParts(selectedImage(candidate)), tag: candidate.version };
    selectedImage(current);
    if (options.customerValues.every((path) => existsSync(path))) {
      mirror = customerRepository(options, current, previousValues);
      if (mirror) image.repository = mirror;
    }
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  if (
    !DNS.test(options.namespace) ||
    options.namespace.length > 63 ||
    !DNS.test(options.release) ||
    options.release.length > 53
  )
    reasons.push(
      "Explicit valid namespace and Helm release names are required",
    );
  const chart = candidate.artifacts.chart;
  if (!chart) reasons.push("Candidate manifest has no pinned chart artifact");
  else if (!existsSync(options.chart))
    reasons.push("Pinned chart archive is missing");
  else if (
    createHash("sha256").update(readFileSync(options.chart)).digest("hex") !==
    chart.sha256
  )
    reasons.push("Pinned chart checksum does not match candidate manifest");
  if (
    !options.customerValues.length ||
    options.customerValues.some((path) => !existsSync(path))
  )
    reasons.push(
      "Explicit existing customer values files are required; defaults/reuse-values are not a customer configuration backup",
    );
  if (!options.backupReference.trim())
    reasons.push("A database backup reference is required");
  if (
    (candidate.upgrade.requiresDowntime ||
      !candidate.compatibility.database.rollbackCompatible) &&
    !options.backupCommand?.length
  )
    reasons.push(
      "A backup command is required for a fresh backup after maintenance quiescence",
    );
  if (
    !Number.isInteger(options.timeoutSeconds ?? 300) ||
    (options.timeoutSeconds ?? 300) < 1 ||
    (options.timeoutSeconds ?? 300) > 3600
  )
    reasons.push("Timeout must be an integer between 1 and 3600 seconds");
  const annotations = {
    "openbot.ai/distribution": candidate.distribution.id,
    "openbot.ai/release": candidate.version,
    "openbot.ai/source-commit": candidate.source.commit,
  };
  const values: PromotionValues = {
    image,
    commonAnnotations: annotations,
    server: { podAnnotations: annotations },
  };
  if (
    !reasons.length &&
    current.compatibility.database.to !== candidate.compatibility.database.to
  ) {
    try {
      await requireRenderedMigration(options, values, previousValues);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ...common, allowed: reasons.length === 0, reasons, values, mirror };
}
function selector(release: string) {
  return `app.kubernetes.io/instance=${release},app.kubernetes.io/component=server`;
}
async function deployments(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
  cwd = options.outputDirectory,
) {
  const text = await run(
    [
      "kubectl",
      "--namespace",
      options.namespace,
      "get",
      "deployment",
      "--selector",
      selector(options.release),
      "--output",
      "json",
    ],
    { cwd },
  );
  const result: DeploymentList = JSON.parse(text);
  if (!Array.isArray(result.items) || result.items.length !== 1)
    throw new Error(
      "Expected exactly one existing server Deployment for this Helm release",
    );
  const deployment = result.items[0];
  if (!deployment) throw new Error("Server Deployment is absent");
  return deployment;
}
function verifyDeployment(
  deployment: Deployment,
  manifest: ReleaseManifest,
  requireIdentity: boolean,
  mirror?: string,
) {
  const server = deployment.spec.template.spec.containers.find(
    (container) => container.name === "server",
  );
  const declared = imageParts(selectedImage(manifest));
  if (
    !server?.image.endsWith(`@${declared.digest}`) ||
    ![declared.repository, mirror].includes(imageParts(server.image).repository)
  )
    throw new Error(
      "Server Deployment image does not match the declared release artifact",
    );
  const annotations = deployment.spec.template.metadata?.annotations;
  if (
    requireIdentity &&
    (annotations?.["openbot.ai/distribution"] !== manifest.distribution.id ||
      annotations?.["openbot.ai/release"] !== manifest.version ||
      annotations?.["openbot.ai/source-commit"] !== manifest.source.commit)
  )
    throw new Error(
      "Server Deployment release identity does not match the candidate",
    );
  if (
    annotations?.["openbot.ai/distribution"] &&
    annotations["openbot.ai/distribution"] !== manifest.distribution.id
  )
    throw new Error("Existing Deployment belongs to another distribution");
}
function prepareOutput(options: KubernetesPromotionOptions) {
  if (!isAbsolute(options.outputDirectory))
    throw new Error("Promotion output directory must be absolute");
  mkdirSync(options.outputDirectory, { recursive: true, mode: 0o700 });
}
function pendingJournal(options: KubernetesPromotionOptions) {
  const path = join(options.outputDirectory, "promotion-journal.json");
  if (existsSync(path)) {
    const previous: { phase?: string } = JSON.parse(readFileSync(path, "utf8"));
    // `failed` means the release was put back exactly as it was before this tool changed it.
    if (previous.phase !== "accepted" && previous.phase !== "failed")
      throw new Error(
        "An interrupted promotion requires operator recovery; inspect promotion-journal.json",
      );
  }
}
/** The release's user-supplied values, as `helm get values` reports them (`null` when none). */
async function releaseValues(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
  cwd: string,
) {
  const value: unknown = JSON.parse(
    await run(
      [
        "helm",
        "get",
        "values",
        options.release,
        "--namespace",
        options.namespace,
        "--output",
        "json",
      ],
      { cwd },
    ),
  );
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("helm get values did not return a values object");
  return value as Record<string, unknown>;
}
/** Whether Helm applies this release server-side. Helm 4 records `applyMethod: "ssa"` for releases
 * it installed that way; Helm 3 has only client-side apply. Under server-side apply, the CronJob
 * suspension and scale-to-zero this tool makes are owned by kubectl, and an upgrade that declares
 * those fields stops on a field-manager conflict after the pre-upgrade migration has run. */
async function appliesServerSide(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
  cwd: string,
) {
  const version = (
    await run(["helm", "version", "--template", "{{.Version}}"], { cwd })
  ).trim();
  if (Number(version.match(/^v(\d+)\./)?.[1] ?? 0) < 4) return false;
  const metadata: { applyMethod?: string } = JSON.parse(
    await run(
      [
        "helm",
        "get",
        "metadata",
        options.release,
        "--namespace",
        options.namespace,
        "--output",
        "json",
      ],
      { cwd },
    ),
  );
  return metadata.applyMethod === "ssa";
}
/** CronJobs whose `spec.suspend` the release's own manifest declares. Helm sets those from values
 * on every upgrade (`routines.suspend`); every other CronJob keeps whatever the cluster holds. */
async function declaredSuspension(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
) {
  const manifest = await run(
    [
      "helm",
      "get",
      "manifest",
      options.release,
      "--namespace",
      options.namespace,
    ],
    { cwd: options.outputDirectory },
  );
  const names = new Set<string>();
  for (const document of parseAllDocuments(manifest)) {
    if (document.errors.length)
      throw new Error("Helm release manifest is not valid YAML");
    const spec = document.get("spec");
    const name = document.getIn(["metadata", "name"]);
    if (
      document.get("kind") === "CronJob" &&
      typeof name === "string" &&
      isMap(spec) &&
      spec.has("suspend")
    )
      names.add(name);
  }
  return names;
}
async function listCronJobs(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
): Promise<CronJobList> {
  return JSON.parse(
    await run(
      [
        "kubectl",
        "--namespace",
        options.namespace,
        "get",
        "cronjob",
        "--selector",
        `app.kubernetes.io/instance=${options.release}`,
        "--output",
        "json",
      ],
      { cwd: options.outputDirectory },
    ),
  );
}
function setSuspended(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
  name: string,
  suspend: boolean,
) {
  return run(
    [
      "kubectl",
      "--namespace",
      options.namespace,
      "patch",
      "cronjob",
      name,
      "--type=merge",
      "--patch",
      JSON.stringify({ spec: { suspend } }),
    ],
    { cwd: options.outputDirectory },
  );
}
function scaleServer(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
  replicas: number,
) {
  return run(
    [
      "kubectl",
      "--namespace",
      options.namespace,
      "scale",
      "deployment",
      "--selector",
      selector(options.release),
      `--replicas=${replicas}`,
    ],
    { cwd: options.outputDirectory },
  );
}
/** Puts back every CronJob this operation suspended, except one whose suspension the release now
 * declares, which Helm has already set to the customer's value. One the target removed is skipped. */
async function resumeCronJobs(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
  journal: PromotionJournal,
  declared: Set<string>,
) {
  const paused = (journal.pausedCronJobs ?? []).filter(
    (job) => !job.wasSuspended && !declared.has(job.name),
  );
  if (!paused.length) return;
  const present = new Set(
    (await listCronJobs(options, run)).items.map((job) => job.metadata.name),
  );
  for (const job of paused)
    if (present.has(job.name))
      await setSuspended(options, run, job.name, false);
}
export async function promoteKubernetes(
  options: KubernetesPromotionOptions,
): Promise<PromotionJournal> {
  if (!options.acknowledgeInterruption)
    throw new Error(
      "Explicitly acknowledge interruption before live promotion",
    );
  const run = options.run ?? runCommand;
  // Reads only, up to the lock. A refusal here changes nothing and records nothing, so it leaves no
  // journal behind to block the next attempt.
  pendingJournal(options);
  const previousValues = await releaseValues(options, run, process.cwd());
  const plan = await planKubernetesPromotion(options, previousValues);
  if (!plan.allowed) throw new Error(plan.reasons.join("; "));
  const before = await deployments(options, run, process.cwd());
  verifyDeployment(before, options.current, false, plan.mirror);
  const serverSide = await appliesServerSide(options, run, process.cwd());
  prepareOutput(options);
  const lock = join(options.outputDirectory, ".promotion.lock");
  mkdirSync(lock, { mode: 0o700 });
  const timeout = `${options.timeoutSeconds ?? 300}s`;
  const downtime =
    options.candidate.upgrade.requiresDowntime ||
    !options.candidate.compatibility.database.rollbackCompatible;
  let scaledDown = false;
  let verified = false;
  const journal: PromotionJournal = {
    operation: randomUUID(),
    phase: "prepared",
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    namespace: options.namespace,
    release: options.release,
    backupReference: options.backupReference,
    databaseMayHaveChanged: false,
    recovery:
      "No automatic Helm/database rollback. Inspect the migration Job and rollout. Restore only a matching database/configuration backup, or restart previous code only if declared compatible with resulting schema.",
  };
  const phase = (value: PromotionJournal["phase"]) => {
    journal.phase = value;
    atomicJson(
      join(options.outputDirectory, "promotion-journal.json"),
      journal,
    );
  };
  const valuesFile = join(options.outputDirectory, "release-values.json");
  const previousValuesFile = join(
    options.outputDirectory,
    "previous-values.json",
  );
  try {
    atomicJson(
      join(options.outputDirectory, "previous-release.json"),
      options.current,
    );
    atomicJson(previousValuesFile, previousValues);
    atomicJson(valuesFile, plan.values);
    phase("prepared");
    if (downtime) {
      journal.previousReplicas = before.spec.replicas ?? 1;
      const cronJobs = await listCronJobs(options, run);
      journal.pausedCronJobs = cronJobs.items.map((job) => ({
        name: job.metadata.name,
        wasSuspended: job.spec.suspend ?? false,
      }));
      phase("quiescing");
      for (const job of cronJobs.items) {
        if (!(job.spec.suspend ?? false))
          await setSuspended(options, run, job.metadata.name, true);
        for (const active of job.status?.active ?? [])
          await run(
            [
              "kubectl",
              "--namespace",
              options.namespace,
              "wait",
              "--for=condition=complete",
              `job/${active.name}`,
              `--timeout=${timeout}`,
            ],
            { cwd: options.outputDirectory },
          );
      }
      scaledDown = true;
      await scaleServer(options, run, 0);
      await run(
        [
          "kubectl",
          "--namespace",
          options.namespace,
          "wait",
          "--for=delete",
          "pod",
          "--selector",
          selector(options.release),
          `--timeout=${timeout}`,
        ],
        { cwd: options.outputDirectory },
      );
      phase("backing-up");
      if (!options.backupCommand?.length)
        throw new Error("Missing backup command after quiescence");
      await run(options.backupCommand, {
        cwd: options.outputDirectory,
        timeoutMs: (options.timeoutSeconds ?? 300) * 1000,
      });
    }
    journal.databaseMayHaveChanged = true;
    phase("promoting");
    // Later files win: the release's current values, then the customer's files, then the pinned
    // image and identity. So a value set with `--set` at install survives, and the new chart's own
    // defaults still apply to anything nobody set (what `--reset-then-reuse-values` does).
    await run(
      [
        "helm",
        "upgrade",
        options.release,
        resolve(options.chart),
        "--namespace",
        options.namespace,
        "--values",
        previousValuesFile,
        ...options.customerValues.flatMap((path) => [
          "--values",
          resolve(path),
        ]),
        "--values",
        valuesFile,
        // What client-side apply does anyway: the chart's declared values win over this tool's own
        // maintenance changes (suspension, scale to zero) and anything else that edited them.
        ...(serverSide ? ["--force-conflicts"] : []),
        "--wait",
        "--wait-for-jobs",
        "--timeout",
        timeout,
      ],
      {
        cwd: options.outputDirectory,
        timeoutMs: (options.timeoutSeconds ?? 300) * 1000 + 30_000,
      },
    );
    phase("verifying");
    const activated = await deployments(options, run);
    if ((activated.spec.replicas ?? 1) === 0) {
      if (!journal.previousReplicas)
        throw new Error(
          "Target has no serving replicas; automatic activation cannot establish readiness",
        );
      // HPA-owned Deployments omit replicas in the chart; explicitly leave the maintenance
      // scale-to-zero state before waiting for the existing autoscaler to resume.
      await scaleServer(options, run, journal.previousReplicas);
    }
    await run(
      [
        "kubectl",
        "--namespace",
        options.namespace,
        "rollout",
        "status",
        "deployment",
        "--selector",
        selector(options.release),
        `--timeout=${timeout}`,
      ],
      { cwd: options.outputDirectory },
    );
    verifyDeployment(
      await deployments(options, run),
      options.candidate,
      true,
      plan.mirror,
    );
    const deployment = await deployments(options, run);
    const identityText = await run(
      [
        "kubectl",
        "--namespace",
        options.namespace,
        "exec",
        `deployment/${deployment.metadata?.name ?? `${options.release}-server`}`,
        "--container",
        "server",
        "--",
        ...RELEASE_FROM_INSIDE,
      ],
      { cwd: options.outputDirectory, timeoutMs: 15_000 },
    );
    const identity: {
      version?: string;
      commit?: string;
      distributionId?: string;
      repository?: string;
      channel?: string;
    } = JSON.parse(identityText);
    const candidate = options.candidate;
    if (
      identity.version !== candidate.version ||
      identity.commit !== candidate.source.commit ||
      identity.distributionId !== candidate.distribution.id ||
      identity.repository !== candidate.distribution.repository ||
      identity.channel !== candidate.distribution.channel
    )
      throw new Error(
        "Running server release identity does not match the candidate",
      );
    verified = true;
    // The candidate is serving. Scheduled work goes back to exactly how it was before quiescing.
    await resumeCronJobs(
      options,
      run,
      journal,
      await declaredSuspension(options, run),
    );
    // Helm --wait waits for chart workload readiness and migration Jobs. Additional customer
    // workflow acceptance remains the operator's responsibility and is not implied by this record.
    atomicJson(
      join(options.outputDirectory, "accepted-release.json"),
      options.candidate,
    );
    phase("accepted");
    return journal;
  } catch (error) {
    journal.error = error instanceof Error ? error.message : String(error);
    if (!journal.databaseMayHaveChanged) {
      // Helm never ran, so the database is as it was. Undo the quiescing exactly; the release is
      // then as this tool found it, and another attempt may follow.
      try {
        if (scaledDown && journal.previousReplicas !== undefined)
          await scaleServer(options, run, journal.previousReplicas);
        await resumeCronJobs(options, run, journal, new Set());
        phase("failed");
      } catch (restoreError) {
        journal.error += `; putting the release back after quiescing failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
        phase("recovery-required");
      }
    } else {
      // Only a maintenance transition that has not verified needs writes held off. A rollback-
      // compatible transition is left serving: the previous code accepts the resulting schema.
      if (downtime && !verified) {
        try {
          await scaleServer(options, run, 0);
          for (const job of (await listCronJobs(options, run)).items)
            await setSuspended(options, run, job.metadata.name, true);
        } catch (stopError) {
          journal.error += `; maintenance shutdown failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
        }
      }
      phase("recovery-required");
    }
    throw new Error(
      `${journal.error}. Promotion ${journal.phase === "failed" ? "was undone; the release is as it was before" : "requires operator recovery"}; see ${join(options.outputDirectory, "promotion-journal.json")}`,
    );
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Review artifacts only. A GitOps controller must implement the documented migration ordering. */
export async function writeGitOpsPromotion(
  options: KubernetesPromotionOptions,
) {
  const plan = await planKubernetesPromotion(options);
  if (!plan.allowed) throw new Error(plan.reasons.join("; "));
  prepareOutput(options);
  atomicJson(join(options.outputDirectory, "release-values.json"), plan.values);
  atomicJson(
    join(options.outputDirectory, "proposed-release.json"),
    options.candidate,
  );
  writeFileSync(
    join(options.outputDirectory, "ORDERING.md"),
    `# Proposed OpenBot promotion\n\nStatus: proposed; no cluster was changed.\n\n1. Verify chart archive SHA-256 ${options.candidate.artifacts.chart?.sha256}; keep customer values and Secret references separate.\n2. For maintenance transitions, stop write admission and scheduled API dispatch, wait for old work to finish or explicitly interrupt it, then create the matching backup (${options.backupReference}).\n3. Run the target image's guarded migration Job and require successful completion before replacing server replicas. Preserve existing database advisory locking and migration-history refusal.\n4. Apply the pinned server/computer workloads and wait for readiness and rollout, then verify image digest and release annotations.\n5. Resume routines and perform the customer browser/graph workflow before accepting the promotion.\n\nHelm's existing pre-upgrade hook supplies step 3 only when Helm owns execution. A renderer/controller that ignores Helm hooks must define its own ordered migration phase. First installation with bundled PostgreSQL intentionally uses an ordinary migration Job; it must not be converted into a pre-install hook. No Argo CD or Flux execution integration is claimed by these generated files. A Git revert does not undo database changes.\n`,
    { mode: 0o600 },
  );
  return {
    phase: "proposed" as const,
    values: join(options.outputDirectory, "release-values.json"),
    ordering: join(options.outputDirectory, "ORDERING.md"),
  };
}
