/**
 * The window's view of the local evaluation CLI boundary in src-tauri/src/local_eval.rs.
 *
 * The native layer runs the pinned CLI, normalizes its version-1 JSON and returns only allowlisted
 * facts or a static failure category. Raw CLI output never reaches the window. Runtime and licence
 * decisions stay in the CLI: readiness and licence are its own states, read by exact value.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Problem } from "./Problem";

export type LocalAction = "status" | "start" | "stop";
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
  // `local login` only; the window reads these as a fixed sentence from `open_local_intelligence`.
  | "dashboard-unavailable"
  | "browser-open-failed"
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

export type LocalReport = {
  outcome: LocalOutcome;
  stack: null | {
    id: string;
    installedRelease: string;
    step: string;
    urls: { api: string; dashboard: string; gateway: string };
    hasFailedStep: boolean;
    updateInProgress: boolean;
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
export function setUpLocalEval(root: string): {
  attempt: string;
  report: Promise<LocalReport>;
} {
  const attempt = crypto.randomUUID();
  const report = invoke<LocalReport>("set_up_local_eval", {
    attempt,
    root,
  }).catch((rejection: unknown) => {
    if (rejection && typeof rejection === "object" && "said" in rejection) {
      throw rejection as Problem;
    }
    throw failure(rejection);
  });
  return { attempt, report };
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
 * Signs the browser in to the recorded local stack's Intelligence dashboard with no code to
 * approve. The CLI opens the browser itself, so the window opens nothing. Rejects only with a
 * `Problem` whose sentence is fixed on the native side.
 */
export function openLocalIntelligence(root: string): {
  attempt: string;
  opened: Promise<void>;
} {
  const attempt = crypto.randomUUID();
  const opened = invoke<void>("open_local_intelligence", {
    attempt,
    root,
  }).catch((rejection: unknown) => {
    if (rejection && typeof rejection === "object" && "said" in rejection) {
      throw rejection as Problem;
    }
    throw {
      said: "OpenBot could not open the Intelligence dashboard. Try again.",
    } satisfies Problem;
  });
  return { attempt, opened };
}

/** Whether the menus offer "Open Intelligence dashboard" for `root`. */
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
    canonical(report.readiness, "ready") &&
    canonical(report.licence, "valid")
  );
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
export const intelligenceStopFailed = "Intelligence stop failed: ";

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
    said: "OpenBot stopped, but could not stop the local Intelligence stack it started.",
    detail: line,
  };
}
