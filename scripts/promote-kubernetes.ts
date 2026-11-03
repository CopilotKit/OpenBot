/** Operator-owned, digest-pinned Helm promotion; never called by the running application. */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseReleaseManifest,
  planUpgrade,
  type ReleaseManifest,
  type UpgradePolicy,
} from "../shared/release-manifest";
import { atomicJson, type CommandRunner, runCommand } from "./update-local";

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
    | "recovery-required";
  fromVersion: string;
  toVersion: string;
  namespace: string;
  release: string;
  backupReference: string;
  databaseMayHaveChanged: boolean;
  previousReplicas?: number;
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
export async function planKubernetesPromotion(
  options: KubernetesPromotionOptions,
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
  try {
    image = { ...imageParts(selectedImage(candidate)), tag: candidate.version };
    selectedImage(current);
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
  return { ...common, allowed: reasons.length === 0, reasons, values };
}
function selector(release: string) {
  return `app.kubernetes.io/instance=${release},app.kubernetes.io/component=server`;
}
async function deployments(
  options: KubernetesPromotionOptions,
  run: CommandRunner,
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
    { cwd: options.outputDirectory },
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
) {
  const server = deployment.spec.template.spec.containers.find(
    (container) => container.name === "server",
  );
  if (
    !server?.image.endsWith(`@${imageParts(selectedImage(manifest)).digest}`) ||
    imageParts(server.image).repository !==
      imageParts(selectedImage(manifest)).repository
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
    if (previous.phase !== "accepted")
      throw new Error(
        "An interrupted promotion requires operator recovery; inspect promotion-journal.json",
      );
  }
}
export async function promoteKubernetes(
  options: KubernetesPromotionOptions,
): Promise<PromotionJournal> {
  const plan = await planKubernetesPromotion(options);
  if (!plan.allowed) throw new Error(plan.reasons.join("; "));
  if (!options.acknowledgeInterruption)
    throw new Error(
      "Explicitly acknowledge interruption before live promotion",
    );
  prepareOutput(options);
  pendingJournal(options);
  const lock = join(options.outputDirectory, ".promotion.lock");
  mkdirSync(lock, { mode: 0o700 });
  const run = options.run ?? runCommand;
  let mutationStarted = false;
  const timeout = `${options.timeoutSeconds ?? 300}s`;
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
  try {
    const before = await deployments(options, run);
    verifyDeployment(before, options.current, false);
    atomicJson(
      join(options.outputDirectory, "previous-release.json"),
      options.current,
    );
    atomicJson(
      join(options.outputDirectory, "release-values.json"),
      plan.values,
    );
    phase("prepared");
    if (
      options.candidate.upgrade.requiresDowntime ||
      !options.candidate.compatibility.database.rollbackCompatible
    ) {
      phase("quiescing");
      journal.previousReplicas = before.spec.replicas ?? 1;
      const cronJobs: CronJobList = JSON.parse(
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
      journal.pausedCronJobs = cronJobs.items.map((job) => ({
        name: job.metadata.name,
        wasSuspended: job.spec.suspend ?? false,
      }));
      phase("quiescing");
      mutationStarted = true;
      for (const job of cronJobs.items) {
        await run(
          [
            "kubectl",
            "--namespace",
            options.namespace,
            "patch",
            "cronjob",
            job.metadata.name,
            "--type=merge",
            "--patch",
            '{"spec":{"suspend":true}}',
          ],
          { cwd: options.outputDirectory },
        );
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
      await run(
        [
          "kubectl",
          "--namespace",
          options.namespace,
          "scale",
          "deployment",
          "--selector",
          selector(options.release),
          "--replicas=0",
        ],
        { cwd: options.outputDirectory },
      );
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
      // Target CronJobs are reconciled by Helm after the guarded pre-upgrade migration. Their
      // declared target/customer suspension policy takes effect with the target workloads.
      phase("backing-up");
      if (!options.backupCommand?.length)
        throw new Error("Missing backup command after quiescence");
      await run(options.backupCommand, {
        cwd: options.outputDirectory,
        timeoutMs: (options.timeoutSeconds ?? 300) * 1000,
      });
    }
    journal.databaseMayHaveChanged = true;
    mutationStarted = true;
    phase("promoting");
    await run(
      [
        "helm",
        "upgrade",
        options.release,
        resolve(options.chart),
        "--namespace",
        options.namespace,
        ...options.customerValues.flatMap((path) => [
          "--values",
          resolve(path),
        ]),
        "--values",
        join(options.outputDirectory, "release-values.json"),
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
      await run(
        [
          "kubectl",
          "--namespace",
          options.namespace,
          "scale",
          "deployment",
          "--selector",
          selector(options.release),
          `--replicas=${journal.previousReplicas}`,
        ],
        { cwd: options.outputDirectory },
      );
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
    verifyDeployment(await deployments(options, run), options.candidate, true);
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
        "bun",
        "-e",
        "const r=await fetch('http://127.0.0.1:'+(process.env.PORT||process.env.SERVER_PORT||3001)+'/release'); if(!r.ok)process.exit(1); console.log(JSON.stringify(await r.json()));",
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
    if (mutationStarted) {
      try {
        await run(
          [
            "kubectl",
            "--namespace",
            options.namespace,
            "scale",
            "deployment",
            "--selector",
            selector(options.release),
            "--replicas=0",
          ],
          { cwd: options.outputDirectory },
        );
        const jobs: CronJobList = JSON.parse(
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
        for (const job of jobs.items)
          await run(
            [
              "kubectl",
              "--namespace",
              options.namespace,
              "patch",
              "cronjob",
              job.metadata.name,
              "--type=merge",
              "--patch",
              '{"spec":{"suspend":true}}',
            ],
            { cwd: options.outputDirectory },
          );
      } catch (stopError) {
        journal.error += `; maintenance shutdown failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
      }
    }
    phase("recovery-required");
    throw new Error(
      `${journal.error}. Promotion requires operator recovery; see ${join(options.outputDirectory, "promotion-journal.json")}`,
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
