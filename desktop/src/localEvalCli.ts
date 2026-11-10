/**
 * The window's view of the local evaluation CLI boundary in src-tauri/src/local_eval.rs.
 *
 * The native layer runs the pinned CLI, normalizes its version-1 JSON and returns only allowlisted
 * facts or a static failure category. Raw CLI output never reaches the window. Runtime and licence
 * decisions stay in the CLI: readiness and licence are its own states, read by exact value.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Problem } from "./Problem";

/** `update` installs the release this app's CLI installs over an older stack, keeping its data. */
export type LocalAction = "status" | "start" | "stop" | "update";
export type LocalOutcome = "completed" | "blocked" | "failed";

/** Static categories from `local_eval::Failure`. None carries CLI output. */
export const localFailures = [
  "unavailable",
  "unverified",
  "invalid-stack",
  "spawn",
  "timeout",
  "cancelled",
  "output-limit",
  "invalid-json",
  "unsupported-version",
  "unexpected-command",
  "invalid-status",
  "missing-stack",
  "unsafe-endpoint",
  "contract-mismatch",
  "unexpected-exit",
  "invalid-acceptance",
  "rootless-podman",
  "download-stalled",
] as const;
export type LocalFailure = (typeof localFailures)[number];

/** The CLI's own blocker reasons, from `local_eval::Reason`. */
export type LocalReason =
  | "authentication-required"
  | "eula-acceptance-required"
  | "eula-unavailable"
  | "eula-declined"
  | "release-unavailable"
  | "feature-disabled"
  | "unsupported-platform"
  | "unsupported-engine"
  | "port-unavailable"
  | "docker-unavailable"
  | "update-recovery-required"
  | "incompatible-release"
  | "local-command-busy"
  | "local-command-failed"
  | "confirmation-required"
  // `local login` only; the menu says these as a fixed sentence.
  | "dashboard-unavailable"
  | "browser-open-failed"
  // The CLI's resource check failed: the report's `shortfall` says which resource is short.
  | "resources-short"
  | "unrecognized";

/** `local_eval::Readiness`: the CLI's own end-to-end check. Running pods are not this. */
export const localReadinesses = [
  "ready",
  "starting",
  "stopped",
  "degraded",
  "unknown",
] as const;
export type LocalReadiness = (typeof localReadinesses)[number];

/** `local_eval::Licence`, as the CLI verified it. */
export const localLicences = [
  "valid",
  "expired",
  "missing",
  "invalid",
  "organization-mismatch",
  "unknown",
] as const;
export type LocalLicence = (typeof localLicences)[number];

/** `local_eval::Shortfall`: which of the engine's resources are short, and whether it is Podman. */
export type Shortfall = {
  podman: boolean;
  cpu: boolean;
  memory: boolean;
  disk: boolean;
  /** What the CLI measured free, as it said it: CPUs, and GB of memory and of disk. */
  cpus?: string;
  memoryGb?: string;
  diskGb?: string;
  /**
   * OpenBot's own check after a start that failed: the back end's disk is nearly full, and how
   * large it is beside `diskGb`.
   */
  nearlyFull?: boolean;
  diskSizeGb?: string;
  /**
   * The node still reports low disk with the disk above both lines: space was freed, and the
   * back end recovers by itself within minutes.
   */
  recovering?: boolean;
  /** Podman on Windows, in WSL: `podman machine set` changes nothing there. */
  wsl?: boolean;
  /** The drive that holds its machine's disk, `C:`. */
  drive?: string;
};

export type LocalReport = {
  outcome: LocalOutcome;
  /**
   * With the reason `resources-short`: which resources the CLI found short. With readiness
   * `degraded`: a disk OpenBot found short, or recovering, behind a back end that does not answer.
   */
  shortfall?: Shortfall;
  stack: null | {
    id: string;
    installedRelease: string;
    step: string;
    urls: { api: string; dashboard: string; gateway: string };
    hasFailedStep: boolean;
    updateInProgress: boolean;
    /** `local_eval::UnfinishedUpdate`: an update the CLI keeps on record because it did not finish. */
    unfinishedUpdate: null | {
      to: string;
      /** No migration started: the release that answers is `installedRelease`. */
      prepared: boolean;
      stoppedDownloading: boolean;
      /** The CLI's name for the step that failed, such as `update-quiesce`, when it recorded one. */
      failedStep?: string;
    };
    observed: null | {
      running: boolean;
      services: { name: string; phase: string; ready: boolean }[];
    };
  };
  reason: LocalReason | null;
  // Unknown when the CLI does not publish the fact, or publishes something this build cannot read.
  readiness: LocalReadiness;
  licence: LocalLicence;
  /** A strict ISO-8601 instant, or null. */
  licenceExpiresAt: string | null;
  /**
   * On `status`: the release this app's CLI installs, when the stack runs an older one
   * (`local_eval::update_due`). Absent or null when there is nothing to update.
   */
  updateTo?: string | null;
  /**
   * Every check the CLI made from this computer passed: API, gateway and dashboard. Not readiness:
   * see `onInstalledRelease`.
   */
  checksPassed: boolean;
};

/** What `local connect` answered. The key it wrote went to the credential store, not here. */
export type LocalConnection = {
  outcome: LocalOutcome;
  stack: LocalReport["stack"];
  reason: LocalReason | null;
  /** Settings the CLI wrote earlier were changed since, and it kept them. */
  conflicted: boolean;
};

/** The stacks the CLI has recorded. App folders are not included. */
export type LocalListing = {
  outcome: LocalOutcome;
  stacks: NonNullable<LocalReport["stack"]>[];
  reason: LocalReason | null;
};

export class LocalEvalError extends Error {
  constructor(readonly category: LocalFailure | "unrecognized") {
    super(category);
    this.name = "LocalEvalError";
  }
}

function failure(rejection: unknown): LocalEvalError {
  // Only a known static category is passed on. Anything else is not echoed.
  const known = localFailures.find((category) => category === rejection);
  return new LocalEvalError(known ?? "unrecognized");
}

/**
 * Starts one CLI call. `attempt` names it for `cancelLocalEval`, which works even before the
 * native side has started the call.
 */
export function runLocalEval(
  action: LocalAction,
  stack: string,
): { attempt: string; report: Promise<LocalReport> } {
  const attempt = crypto.randomUUID();
  const report = invoke<LocalReport>("run_local_eval", {
    attempt,
    action,
    stack,
  }).catch((rejection: unknown) => {
    throw failure(rejection);
  });
  return { attempt, report };
}

/** Lists recorded stacks, so a stack id comes from the CLI. Cancel it like any other call. */
export function listLocalEval(): {
  attempt: string;
  listing: Promise<LocalListing>;
} {
  const attempt = crypto.randomUUID();
  const listing = invoke<LocalListing>("list_local_eval", { attempt }).catch(
    (rejection: unknown) => {
      throw failure(rejection);
    },
  );
  return { attempt, listing };
}

/**
 * `local setup` for this installation. A stack it completes is recorded as OpenBot's, so it
 * starts and stops with OpenBot. Blocked is an answer, not an error: the first is usually the
 * evaluation terms. A stack that was set up but could not be recorded rejects with a `Problem`.
 */
export function setUpLocalEval(
  root: string,
  /** The agreement version the person accepted in this window, once they have. */
  acceptedEulaVersion: string | null = null,
): {
  attempt: string;
  report: Promise<LocalReport>;
} {
  const attempt = crypto.randomUUID();
  const report = invoke<LocalReport>("set_up_local_eval", {
    attempt,
    root,
    acceptedEulaVersion,
  }).catch((rejection: unknown) => {
    if (rejection && typeof rejection === "object" && "said" in rejection) {
      throw rejection as Problem;
    }
    throw failure(rejection);
  });
  return { attempt, report };
}

/**
 * Signs in to CopilotKit, which local Intelligence needs for its evaluation licence. The CLI opens
 * the approval page in the browser; this settles once the person approved it there (true) or it
 * did not finish (false).
 */
export function signInToCopilotKit(): {
  attempt: string;
  signedIn: Promise<boolean>;
} {
  const attempt = crypto.randomUUID();
  const signedIn = invoke<{ signedIn: boolean }>("sign_in_to_copilotkit", {
    attempt,
  }).then(
    (answer) => answer.signedIn,
    (rejection: unknown) => {
      throw failure(rejection);
    },
  );
  return { attempt, signedIn };
}

/** The approval page a CopilotKit sign-in is waiting on, and the code that page shows. */
export type CopilotKitSignInPage = { url: string; userCode: string };

/**
 * The page the CLI opened for the sign-in `attempt`, once it has opened one, or null. A code that
 * expires unapproved is replaced, so ask again while the sign-in waits.
 */
export function copilotKitSignInPage(
  attempt: string,
): Promise<CopilotKitSignInPage | null> {
  return invoke<CopilotKitSignInPage | null>("copilotkit_sign_in_page", {
    attempt,
  });
}

/** How much of the back end's download has arrived, in bytes, of how much in all. */
export type LocalDownload = { done: number; total: number };

/**
 * How far the download before the setup or update `attempt` has got, while it downloads,
 * or null. OpenBot downloads the back end's images itself before the CLI pulls them, so a slow
 * line can be told apart from a stuck one.
 */
export async function localEvalDownload(
  attempt: string,
): Promise<LocalDownload | null> {
  const found = await invoke<unknown>("local_eval_download", { attempt });
  // Only two byte counts, and only once there is something to download.
  if (!found || typeof found !== "object") return null;
  const { done, total } = found as Partial<LocalDownload>;
  return typeof done === "number" && typeof total === "number" && total > 0
    ? { done, total }
    : null;
}

/** The CLI's steps a running setup, start or update has finished, by name, and for how long since. */
export type LocalSteps = { ended: string[]; quietSeconds: number };

/** A CLI step name, and nothing that could carry more. */
function stepName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

/**
 * The steps the running call `attempt` has finished, while it runs (`local_eval_steps`), or null.
 * Only step names: the window turns them into plain words (`journey.ts`).
 */
export async function localEvalSteps(
  attempt: string,
): Promise<LocalSteps | null> {
  const found = await invoke<unknown>("local_eval_steps", { attempt });
  if (!found || typeof found !== "object") return null;
  const { ended, quietSeconds } = found as Record<string, unknown>;
  if (!Array.isArray(ended) || typeof quietSeconds !== "number") return null;
  return { ended: ended.filter(stepName), quietSeconds };
}

/**
 * The steps of a back end update that wait long enough to need saying, as the native side names
 * them (`local_update::UpdateStep`), in the CLI's own words for them.
 */
const UPDATE_STEPS = {
  "update-quiesce": "Pausing OpenBot's services",
  "dependencies-install": "Updating where OpenBot keeps your data",
  "dependencies-wait": "Waiting for where OpenBot keeps your data",
  jobs: "Updating your data",
  "services-start": "Starting OpenBot's services",
} as const;

export type LocalUpdateStep = {
  step: keyof typeof UPDATE_STEPS;
  /** What the step is, said. */
  said: string;
  /** How long the update has been in it. */
  seconds: number;
  /** In `jobs`: the Job it waits on, by its name in the cluster. */
  job: string | null;
  /** A Job this update started that failed, said as soon as it does. */
  failedJob: string | null;
};

/** A Kubernetes object name, and nothing that could carry more. */
function jobName(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value)
    ? value
    : null;
}

/**
 * The step the back end update `attempt` is in, once it is in one that waits, or null. The CLI
 * says nothing while a step runs, and some wait ten minutes, so the row says which one it is.
 */
export async function localEvalUpdateStep(
  attempt: string,
): Promise<LocalUpdateStep | null> {
  const found = await invoke<unknown>("local_eval_update_step", { attempt });
  if (!found || typeof found !== "object") return null;
  const { step, seconds, job, failedJob } = found as Record<string, unknown>;
  if (
    typeof step !== "string" ||
    !Object.keys(UPDATE_STEPS).includes(step) ||
    typeof seconds !== "number"
  )
    return null;
  const known = step as keyof typeof UPDATE_STEPS;
  return {
    step: known,
    said: UPDATE_STEPS[known],
    seconds,
    job: jobName(job),
    failedJob: jobName(failedJob),
  };
}

/**
 * The CLI's step names (`failedStep`) in plain words, for "It stopped while …": what the step was
 * doing for the person, from the phases its own progress shows (`localSetupStepLabel` in the CLI's
 * `local-setup-progress.ts`). The step's own name is in the log.
 */
export function updateStepSaid(step: string): string {
  if (/^(docker|engine|resource|runtime)-/.test(step))
    return "checking this computer";
  if (step.startsWith("release-")) return "choosing the version to install";
  if (
    /^(chart-download|image-download|system-image-download|system-image-tag)$/.test(
      step,
    )
  )
    return "downloading the update";
  if (step === "chart-render") return "preparing the update";
  if (/^(cluster-|kubeconfig|ownership-check|running-check)/.test(step))
    return "preparing this computer";
  if (step === "secrets-apply") return "applying your settings";
  if (step.startsWith("update-")) return "pausing OpenBot's services";
  if (step === "dependencies-install")
    return "updating where OpenBot keeps your data";
  if (step === "dependencies-wait")
    return "waiting for where OpenBot keeps your data";
  if (step.startsWith("migration-")) return "updating your data";
  if (/^(hook-|bootstrap-)/.test(step))
    return "preparing your organization and project";
  if (/^(services-|stack-|service-status)/.test(step))
    return "starting OpenBot's services";
  return "updating";
}

/**
 * Connects this installation's apps with the CopilotKit sign-in the CLI now holds: CopilotKit
 * makes or replays its Composio project, and the native side keeps the key. Resolves once
 * connected, or when a key was already in place. Rejects with a `Problem` the window shows as it
 * is; nothing secret comes back either way.
 */
export function connectCopilotKitApps(root: string): {
  attempt: string;
  connected: Promise<void>;
} {
  const attempt = crypto.randomUUID();
  const connected = invoke<void>("connect_copilotkit_apps", {
    attempt,
    root,
  }).catch((rejection: unknown) => {
    if (rejection && typeof rejection === "object" && "said" in rejection) {
      throw rejection as Problem;
    }
    // Anything else is not echoed.
    throw { said: APPS_UNAVAILABLE } satisfies Problem;
  });
  return { attempt, connected };
}

/** What the native side says when apps could not be connected (`composio::setup_problem`). */
export const APPS_UNAVAILABLE =
  "OpenBot couldn't connect your apps. Check your connection, then choose Connect apps. If it keeps happening, ask an admin.";

/** The evaluation agreement, as the CLI reports it: what the person reads before Accept. */
export type LocalTerms =
  | {
      status: "required";
      accepted: boolean;
      version: string;
      url: string;
      organizationName: string;
    }
  | { status: "not-required" | "unavailable" | "signed-out" }
  /** No container engine answers yet, so the CLI says nothing about the account. */
  | { status: "engine-not-ready" }
  /**
   * The CLI's preflight refused this computer for a reason waiting does not change, such as
   * OrbStack on a Mac. `said` is the CLI's own sentence, when it gave one; `switchEngine` when the
   * engine itself is refused and Docker Desktop or Podman is the fix.
   */
  | {
      status: "blocked";
      reason: LocalReason;
      said?: string;
      switchEngine?: boolean;
    }
  /** OpenBot's own check: the engine has fewer CPUs or less memory than local setup needs. */
  | ({ status: "engine-too-small" } & Shortfall);

export function localEvalTerms(): {
  attempt: string;
  terms: Promise<LocalTerms>;
} {
  const attempt = crypto.randomUUID();
  const terms = invoke<LocalTerms>("local_eval_terms", { attempt }).catch(
    (rejection: unknown) => {
      throw failure(rejection);
    },
  );
  return { attempt, terms };
}

/**
 * `local connect` for this installation, after the person chose to connect OpenBot. The native
 * side keeps the key the CLI wrote as OpenBot's Intelligence key. A connection it would not take
 * up rejects with a `Problem`.
 */
export function connectLocalEval(root: string): {
  attempt: string;
  connection: Promise<LocalConnection>;
} {
  const attempt = crypto.randomUUID();
  const connection = invoke<LocalConnection>("connect_local_eval", {
    attempt,
    root,
  }).catch((rejection: unknown) => {
    if (rejection && typeof rejection === "object" && "said" in rejection) {
      throw rejection as Problem;
    }
    throw failure(rejection);
  });
  return { attempt, connection };
}

/**
 * The installation's engine answering before any CLI call: Docker Desktop opened, or OpenBot's
 * Podman machine started, when either is stopped. What the native side says meanwhile, such as
 * Docker's hand-off, arrives as setup progress (see `handOffNow`). Rejects with a `Problem` when
 * the engine would not start.
 */
export async function wakeEngine(root: string): Promise<void> {
  await invoke("wake_engine", { root });
}

/**
 * The wait for the back end to report ready ended without it, and why, in the sentence the window
 * shows. The log then says how long it waited and what the last status was (`back_end_wait_ended`).
 * Never fails the step it is about.
 */
export function backEndWaitEnded(why: string): void {
  invoke("back_end_wait_ended", { why }).catch(() => {});
}

/** Whether the OpenBot app's page may offer the back end dashboard for `root`. */
export function offerLocalIntelligence(
  root: string,
  offered: boolean,
): Promise<void> {
  return invoke("offer_local_intelligence", { root, offered });
}

/** Stops one call; it then rejects with `cancelled`. */
export function cancelLocalEval(attempt: string): Promise<void> {
  return invoke("cancel_local_eval", { attempt });
}

export type ChatBlocker = "intelligence" | "openbot" | "provider";

export type ChatGateInput = {
  /** The latest status call: a report, a failure category, or nothing yet. */
  intelligence: LocalReport | LocalFailure | null;
  openBot: "connected" | "not-connected" | "unknown";
  provider: "validated" | "invalid" | "unvalidated";
};

/**
 * Chat opens only when all three independent facts are known good. Unknown is blocked, never
 * guessed ready: a CLI that does not report readiness and licence cannot open it.
 */
export function chatGate(state: ChatGateInput): {
  open: boolean;
  blockers: ChatBlocker[];
} {
  const blockers: ChatBlocker[] = [];
  if (!intelligenceReady(state.intelligence)) blockers.push("intelligence");
  if (state.openBot !== "connected") blockers.push("openbot");
  if (state.provider !== "validated") blockers.push("provider");
  return { open: blockers.length === 0, blockers };
}

function intelligenceReady(report: ChatGateInput["intelligence"]): boolean {
  if (report === null || typeof report === "string") return false;
  return (
    report.outcome === "completed" &&
    (canonical(report.readiness, "ready") ||
      onInstalledRelease(report) !== null) &&
    canonical(report.licence, "valid")
  );
}

/**
 * The back end runs the release it has, and is ready on it, while the CLI keeps an update it did
 * not finish on record. Null for anything else.
 *
 * Found on a slow connection: `local update` stopped downloading one of the new release's images
 * at the CLI's own limit. Nothing in the cluster had changed and every check passed, but the CLI
 * reports `degraded` for as long as the record stays, and the window said the back end was not
 * healthy and stopped. Ready here only when every check passed and the update was still
 * `prepared`, so no migration had started. A check that fails is still not healthy.
 */
export function onInstalledRelease(report: LocalReport): {
  release: string;
  update: NonNullable<NonNullable<LocalReport["stack"]>["unfinishedUpdate"]>;
} | null {
  const update = report.stack?.unfinishedUpdate;
  if (
    report.outcome !== "completed" ||
    !canonical(report.readiness, "degraded") ||
    report.checksPassed !== true ||
    !report.stack ||
    !update?.prepared
  ) {
    return null;
  }
  return { release: report.stack.installedRelease, update };
}

// Positive match only: a future value that is not exactly the good one still blocks.
function canonical(value: string, good: string): boolean {
  return value === good;
}

const WARN_BEFORE_EXPIRY_MS = 5 * 24 * 60 * 60 * 1000;

/** The licence expires within five days of `now`. Desktop warns; it never renews on its own. */
export function licenceExpiresSoon(
  report: LocalReport,
  now: number = Date.now(),
): boolean {
  if (report.licenceExpiresAt === null) return false;
  const expires = Date.parse(report.licenceExpiresAt);
  return !Number.isNaN(expires) && expires - now <= WARN_BEFORE_EXPIRY_MS;
}

/** How main.rs starts an Intelligence stop failure (`INTELLIGENCE_STOP_FAILED`). */
export const intelligenceStopFailed = "Backend stop failed: ";

/**
 * Splits a Stop failure into OpenBot's own lines and the local Intelligence stack's. OpenBot has
 * stopped when only the second is present. Anything not in the native line format is OpenBot's.
 */
export function splitStopFailure(thrown: unknown): {
  openBot: string | null;
  intelligence: string | null;
} {
  if (typeof thrown !== "string") {
    return { openBot: String(thrown), intelligence: null };
  }
  const lines = thrown.split("\n");
  const own = lines.filter((line) => !line.startsWith(intelligenceStopFailed));
  const intelligence = lines.filter((line) =>
    line.startsWith(intelligenceStopFailed),
  );
  return {
    openBot: own.length ? own.join("\n") : null,
    intelligence: intelligence.length ? intelligence.join("\n") : null,
  };
}

export function intelligenceStopProblem(line: string): Problem {
  return {
    said: "OpenBot stopped, but some of its services didn't. They may still be running.",
    detail: line,
  };
}
