/**
 * One promotion of an OpenBot release on Kubernetes, shared by the operator's promotion tool
 * (`bun scripts/update.ts kubernetes`, scripts/promote-kubernetes.ts) and the opt-in management
 * agent (management-agent/). Both keep the same order and the same journal:
 *
 *   prepared -> quiescing -> backing-up -> promoting -> verifying -> accepted
 *
 * For a release that needs downtime or changes the database in a way the previous release cannot
 * read, write admission stops first: every release CronJob is suspended and waited for, and the
 * server scales to zero. Then a fresh backup is taken and must succeed. Only then does the new
 * release apply (the tool runs `helm upgrade`; the agent pins Flux to the release's chart digest).
 * The result is verified by the server Deployment's pinned image and release annotations and by
 * what the running server says about itself on /release.
 *
 * Nothing rolls back on its own. A failure before the release applied puts the quiescing back
 * exactly (`failed`, another attempt may follow). A failure after it applied, when the database may
 * have changed, holds writes off and ends in `recovery-required`, which blocks every further
 * promotion until a person has recovered.
 */
import type { ReleaseManifest } from "./release-manifest";

/** Runs one command without a shell and resolves with its standard output. */
export type KubeRunner = (
  command: readonly string[],
  options: { cwd: string; timeoutMs?: number },
) => Promise<string>;

/** The running server's own account of its release, read from inside its container. */
export const RELEASE_FROM_INSIDE = [
  "bun",
  "-e",
  "const r=await fetch('http://127.0.0.1:'+(process.env.PORT||process.env.SERVER_PORT||3001)+'/release'); if(!r.ok)process.exit(1); console.log(JSON.stringify(await r.json()));",
];

export type PromotionPhase =
  | "prepared"
  | "quiescing"
  | "backing-up"
  | "promoting"
  | "verifying"
  | "accepted"
  | "failed"
  | "recovery-required";

export interface PromotionJournal {
  operation: string;
  phase: PromotionPhase;
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
  /** What the operation went ahead despite, for a person to read (the agent's backup target check
   * skipped for a server that predates it, say). */
  warnings?: string[];
  recovery: string;
}

export interface Deployment {
  metadata?: { name?: string };
  spec: {
    replicas?: number;
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        containers: { name: string; image: string }[];
        terminationGracePeriodSeconds?: number;
      };
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

/** The release being promoted: its namespace, its Helm release name, and where commands run. */
export interface PromotionTarget {
  namespace: string;
  release: string;
  /** Working directory for every command. */
  cwd: string;
  timeoutSeconds: number;
}

/** The values a promotion pins on top of the customer's: the image by digest and the release's
 * identity, which verification reads back from the server Deployment. */
export interface PromotionValues {
  image: { repository: string; tag: string; digest: string };
  commonAnnotations: Record<string, string>;
  server: { podAnnotations: Record<string, string> };
}

export function selectedImage(manifest: ReleaseManifest) {
  const image = manifest.artifacts.images.openbot;
  if (!image)
    throw new Error(
      "Kubernetes requires the monolithic 'openbot' image; the desktop server image does not contain every chart component",
    );
  return image.reference;
}
export function imageParts(reference: string) {
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
export function promotionValues(
  candidate: ReleaseManifest,
  image: PromotionValues["image"],
): PromotionValues {
  const annotations = {
    "openbot.ai/distribution": candidate.distribution.id,
    "openbot.ai/release": candidate.version,
    "openbot.ai/source-commit": candidate.source.commit,
  };
  return {
    image,
    commonAnnotations: annotations,
    server: { podAnnotations: annotations },
  };
}
/** Whether a promotion to `candidate` stops writes and takes a fresh backup first. */
export function needsMaintenance(candidate: ReleaseManifest) {
  return (
    candidate.upgrade.requiresDowntime ||
    !candidate.compatibility.database.rollbackCompatible
  );
}

/** Kubernetes' termination grace period for a pod template that sets none. */
const DEFAULT_GRACE_SECONDS = 30;
/** Past the grace period, for the kubelet to stop the pod and its deletion to reach the API. */
const DELETION_MARGIN_SECONDS = 60;
/**
 * How long to wait for the server's pods to be gone once it is scaled to zero. A stopping server
 * keeps serving, then drains its in-flight runs for up to its termination grace period, which an
 * install may set far above the promotion timeout. The wait covers that grace period, so a drain is
 * never cut short or taken for a failure; the promotion timeout stays the least it waits.
 */
export function serverStopSeconds(
  deployment: Deployment,
  timeoutSeconds: number,
) {
  const grace =
    deployment.spec.template.spec.terminationGracePeriodSeconds ??
    DEFAULT_GRACE_SECONDS;
  return Math.max(timeoutSeconds, grace + DELETION_MARGIN_SECONDS);
}

export function serverSelector(release: string) {
  return `app.kubernetes.io/instance=${release},app.kubernetes.io/component=server`;
}
export async function serverDeployment(
  target: PromotionTarget,
  run: KubeRunner,
  cwd = target.cwd,
) {
  const text = await run(
    [
      "kubectl",
      "--namespace",
      target.namespace,
      "get",
      "deployment",
      "--selector",
      serverSelector(target.release),
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
export function verifyDeployment(
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
export async function listCronJobs(
  target: PromotionTarget,
  run: KubeRunner,
): Promise<CronJobList> {
  return JSON.parse(
    await run(
      [
        "kubectl",
        "--namespace",
        target.namespace,
        "get",
        "cronjob",
        "--selector",
        `app.kubernetes.io/instance=${target.release}`,
        "--output",
        "json",
      ],
      { cwd: target.cwd },
    ),
  );
}
export function setSuspended(
  target: PromotionTarget,
  run: KubeRunner,
  name: string,
  suspend: boolean,
) {
  return run(
    [
      "kubectl",
      "--namespace",
      target.namespace,
      "patch",
      "cronjob",
      name,
      "--type=merge",
      "--patch",
      JSON.stringify({ spec: { suspend } }),
    ],
    { cwd: target.cwd },
  );
}
export function scaleServer(
  target: PromotionTarget,
  run: KubeRunner,
  replicas: number,
) {
  return run(
    [
      "kubectl",
      "--namespace",
      target.namespace,
      "scale",
      "deployment",
      "--selector",
      serverSelector(target.release),
      `--replicas=${replicas}`,
    ],
    { cwd: target.cwd },
  );
}
/** Puts back every CronJob this operation suspended, except one whose suspension the release now
 * declares, which Helm has already set to the customer's value. One the target removed is skipped. */
export async function resumeCronJobs(
  target: PromotionTarget,
  run: KubeRunner,
  journal: PromotionJournal,
  declared: Set<string>,
) {
  const paused = (journal.pausedCronJobs ?? []).filter(
    (job) => !job.wasSuspended && !declared.has(job.name),
  );
  if (!paused.length) return;
  const present = new Set(
    (await listCronJobs(target, run)).items.map((job) => job.metadata.name),
  );
  for (const job of paused)
    if (present.has(job.name)) await setSuspended(target, run, job.name, false);
}
export interface ReleaseIdentity {
  version?: string;
  commit?: string;
  distributionId?: string;
  repository?: string;
  channel?: string;
  /** The server's last applied migration: an object on servers that report it, a bare name on
   * earlier ones, absent on older ones still. */
  lastAppliedMigration?:
    | { name: string; hash?: string; createdAt?: string | number }
    | string
    | null;
  /** The database the server is connected to, on servers that report it: its host name (or
   * address), and the Cloud SQL instance connection name when it connects through a Cloud SQL
   * socket. Never credentials or the connection URL. */
  database?: {
    host?: string | null;
    instanceConnectionName?: string | null;
  } | null;
}
/** The name of the last migration a server reports, whichever shape it reports it in. */
export function lastMigrationName(identity: ReleaseIdentity | null) {
  const migration = identity?.lastAppliedMigration;
  if (typeof migration === "string") return migration || null;
  if (
    migration &&
    typeof migration === "object" &&
    typeof migration.name === "string"
  )
    return migration.name || null;
  return null;
}
/** What the running server says on /release, read from inside its container. */
export async function runningIdentity(
  target: PromotionTarget,
  run: KubeRunner,
  deploymentName: string,
): Promise<ReleaseIdentity> {
  return JSON.parse(
    await run(
      [
        "kubectl",
        "--namespace",
        target.namespace,
        "exec",
        `deployment/${deploymentName}`,
        "--container",
        "server",
        "--",
        ...RELEASE_FROM_INSIDE,
      ],
      { cwd: target.cwd, timeoutMs: 15_000 },
    ),
  );
}
/**
 * Whether the running server is the candidate release, by what it says on /release. The commit is
 * not compared: a server reports the commit its image was built from, and a release's manifest
 * names the later commit that released it (v1.1.0's server says 9a11f982a, its manifest
 * e373655cc). Which bytes run is already held by the image digest the Deployment is pinned to.
 */
export function identityMatches(
  identity: ReleaseIdentity,
  candidate: ReleaseManifest,
) {
  return (
    identity.version === candidate.version &&
    identity.distributionId === candidate.distribution.id &&
    identity.repository === candidate.distribution.repository &&
    identity.channel === candidate.distribution.channel
  );
}

/** What differs between the operator's tool and the agent; everything else is `runPromotion`'s. */
export interface PromotionSteps {
  target: PromotionTarget;
  run: KubeRunner;
  candidate: ReleaseManifest;
  journal: PromotionJournal;
  /** Persists the journal after every phase change: a file for the tool, a ConfigMap for the agent. */
  save: (journal: PromotionJournal) => void | Promise<void>;
  /** The server Deployment as it was before anything changed. */
  before: Deployment;
  /** Whether to stop writes and take a fresh backup first; `needsMaintenance(candidate)` when left
   * out. The agent also asks for it whenever the database changes at all. */
  maintenance?: boolean;
  /** A registry mirror the customer chose; the digest stays pinned either way. */
  mirror?: string;
  /** Records what the promotion starts from, before the first phase is written. */
  prepare?: () => void | Promise<void>;
  /** Takes a fresh backup after quiescing and returns only once it is verified. */
  backup: () => Promise<void>;
  /** Applies the candidate and returns once its workloads are rolled out (or have failed). */
  apply: () => Promise<void>;
  /** CronJobs whose suspension the candidate release declares itself. */
  declaredSuspension: () => Promise<Set<string>>;
  /** Records acceptance, before the final phase is written. */
  accepted?: () => void | Promise<void>;
}

export async function runPromotion(
  steps: PromotionSteps,
): Promise<PromotionJournal> {
  const { target, run, candidate, journal } = steps;
  const timeout = `${target.timeoutSeconds}s`;
  const downtime = steps.maintenance ?? needsMaintenance(candidate);
  let scaledDown = false;
  let verified = false;
  const phase = async (value: PromotionPhase) => {
    journal.phase = value;
    await steps.save(journal);
  };
  try {
    await steps.prepare?.();
    await phase("prepared");
    if (downtime) {
      journal.previousReplicas = steps.before.spec.replicas ?? 1;
      const cronJobs = await listCronJobs(target, run);
      journal.pausedCronJobs = cronJobs.items.map((job) => ({
        name: job.metadata.name,
        wasSuspended: job.spec.suspend ?? false,
      }));
      await phase("quiescing");
      for (const job of cronJobs.items) {
        if (!(job.spec.suspend ?? false))
          await setSuspended(target, run, job.metadata.name, true);
        for (const active of job.status?.active ?? [])
          await run(
            [
              "kubectl",
              "--namespace",
              target.namespace,
              "wait",
              "--for=condition=complete",
              `job/${active.name}`,
              `--timeout=${timeout}`,
            ],
            { cwd: target.cwd },
          );
      }
      // The grace period the server's pods are stopped with, read as the server stands now.
      const stopSeconds = serverStopSeconds(
        await serverDeployment(target, run),
        target.timeoutSeconds,
      );
      scaledDown = true;
      await scaleServer(target, run, 0);
      await run(
        [
          "kubectl",
          "--namespace",
          target.namespace,
          "wait",
          "--for=delete",
          "pod",
          "--selector",
          serverSelector(target.release),
          `--timeout=${stopSeconds}s`,
        ],
        { cwd: target.cwd },
      );
      await phase("backing-up");
      await steps.backup();
    }
    journal.databaseMayHaveChanged = true;
    await phase("promoting");
    await steps.apply();
    await phase("verifying");
    const activated = await serverDeployment(target, run);
    if ((activated.spec.replicas ?? 1) === 0) {
      if (!journal.previousReplicas)
        throw new Error(
          "Target has no serving replicas; automatic activation cannot establish readiness",
        );
      // HPA-owned Deployments omit replicas in the chart; explicitly leave the maintenance
      // scale-to-zero state before waiting for the existing autoscaler to resume.
      await scaleServer(target, run, journal.previousReplicas);
    }
    await run(
      [
        "kubectl",
        "--namespace",
        target.namespace,
        "rollout",
        "status",
        "deployment",
        "--selector",
        serverSelector(target.release),
        `--timeout=${timeout}`,
      ],
      { cwd: target.cwd },
    );
    verifyDeployment(
      await serverDeployment(target, run),
      candidate,
      true,
      steps.mirror,
    );
    const deployment = await serverDeployment(target, run);
    const identity = await runningIdentity(
      target,
      run,
      deployment.metadata?.name ?? `${target.release}-server`,
    );
    if (!identityMatches(identity, candidate))
      throw new Error(
        "Running server release identity does not match the candidate",
      );
    verified = true;
    // The candidate is serving. Scheduled work goes back to exactly how it was before quiescing.
    await resumeCronJobs(
      target,
      run,
      journal,
      await steps.declaredSuspension(),
    );
    await steps.accepted?.();
    await phase("accepted");
    return journal;
  } catch (error) {
    journal.error = error instanceof Error ? error.message : String(error);
    if (!journal.databaseMayHaveChanged) {
      // The release never applied, so the database is as it was. Undo the quiescing exactly; the
      // release is then as it was found, and another attempt may follow.
      try {
        if (scaledDown && journal.previousReplicas !== undefined)
          await scaleServer(target, run, journal.previousReplicas);
        await resumeCronJobs(target, run, journal, new Set());
        await phase("failed");
      } catch (restoreError) {
        journal.error += `; putting the release back after quiescing failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
        await phase("recovery-required");
      }
    } else {
      // Only a maintenance transition that has not verified needs writes held off. A rollback-
      // compatible transition is left serving: the previous code accepts the resulting schema.
      if (downtime && !verified) {
        try {
          await scaleServer(target, run, 0);
          for (const job of (await listCronJobs(target, run)).items)
            await setSuspended(target, run, job.metadata.name, true);
        } catch (stopError) {
          journal.error += `; maintenance shutdown failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
        }
      }
      await phase("recovery-required");
    }
    throw new PromotionError(journal);
  }
}

/** A promotion that stopped; `journal.phase` says whether it was undone or needs a person. */
export class PromotionError extends Error {
  constructor(readonly journal: PromotionJournal) {
    super(journal.error ?? "Promotion failed");
  }
}
