/**
 * What the window can honestly say about each part of the local setup.
 *
 * Four rows, one per independent fact: the container runtime, Intelligence, OpenBot's connection
 * to it, and the AI provider key. Every sentence here is static. Nothing from the CLI is shown,
 * because the native boundary passes on only enumerated categories.
 *
 * Unknown is never shown as ready. The Intelligence row is ready only when the CLI itself reports
 * readiness "ready" and licence "valid"; a CLI that reports neither leaves it unknown.
 */
import {
  type ChatGateInput,
  chatGate,
  type LocalFailure,
  type LocalLicence,
  type LocalReason,
  licenceExpiresSoon,
} from "./localEvalCli";

export type ReadinessState = "ready" | "blocked" | "unknown";
export type ReadinessAction =
  | "retry"
  | "start-intelligence"
  | "restart-intelligence"
  | "restart-openbot"
  | "sign-in"
  | "repair";

export type ReadinessRow = {
  state: ReadinessState;
  said: string;
  action?: ReadinessAction;
};

export type ReadinessInput = {
  /** Docker Desktop, as probed by the window. */
  runtime: "running" | "not-running" | "unknown";
  /** The latest status call: a report, a failure category, or nothing yet. */
  intelligence: ChatGateInput["intelligence"];
  openBot: ChatGateInput["openBot"];
  provider: ChatGateInput["provider"];
  /** The clock the licence expiry warning is measured against. */
  now?: number;
};

export type Readiness = {
  runtime: ReadinessRow;
  intelligence: ReadinessRow;
  openBot: ReadinessRow;
  provider: ReadinessRow;
};

function blocked(said: string, action?: ReadinessAction): ReadinessRow {
  return action
    ? { state: "blocked", said, action }
    : { state: "blocked", said };
}

const unavailableHere =
  "Intelligence is not available on this computer or release.";
const contract = "OpenBot did not understand Intelligence's reply.";
const couldNotStart = blocked(
  "Intelligence could not start.",
  "restart-intelligence",
);
const busy = blocked("Another Intelligence command is still running.", "retry");

// Compiler-enforced: a new upstream reason or failure breaks the build here.
const reasonRows: Record<LocalReason, ReadinessRow> = {
  "authentication-required": blocked("Sign in to CopilotKit.", "sign-in"),
  // Acceptance is an explicit step of its own; retrying start cannot satisfy it.
  "eula-acceptance-required": blocked(
    "The Intelligence terms have not been accepted.",
  ),
  "eula-unavailable": blocked(
    "The Intelligence terms could not be shown.",
    "retry",
  ),
  "eula-declined": blocked("The Intelligence terms were declined."),
  "release-unavailable": blocked(unavailableHere),
  "feature-disabled": blocked(unavailableHere),
  "unsupported-platform": blocked(unavailableHere),
  "incompatible-release": blocked(unavailableHere),
  "update-recovery-required": blocked(unavailableHere),
  // The runtime row carries the Docker detail. Here Intelligence is simply blocked behind it.
  "unsupported-engine": blocked(
    "Intelligence cannot run on this computer's current setup.",
  ),
  "docker-unavailable": blocked(
    "Intelligence cannot start until the software it runs on is running.",
    "retry",
  ),
  "port-unavailable": blocked("A port Intelligence needs is in use.", "retry"),
  "local-command-busy": busy,
  "local-command-failed": couldNotStart,
  // OpenBot always approves the connection it asks for, so this is the CLI asking for more.
  "confirmation-required": blocked(
    "Intelligence asked for a confirmation OpenBot cannot give.",
  ),
  // Reasons only `local login` gives; a status that gave one is still blocked, never ready.
  "dashboard-unavailable": blocked(
    "The Intelligence dashboard is not responding yet.",
    "retry",
  ),
  "browser-open-failed": blocked("Your browser did not open.", "retry"),
  unrecognized: couldNotStart,
};

// A licence the CLI verified as anything but valid blocks, however ready Intelligence is.
const licenceRows: Record<
  Exclude<LocalLicence, "valid" | "unknown">,
  ReadinessRow
> = {
  expired: blocked("The Intelligence evaluation licence has expired."),
  missing: blocked("Intelligence has no evaluation licence."),
  invalid: blocked("The Intelligence evaluation licence is not valid."),
  "organization-mismatch": blocked(
    "The Intelligence licence belongs to a different organization.",
  ),
};

const failureRows: Record<LocalFailure, ReadinessRow> = {
  unavailable: blocked(
    "This version of OpenBot cannot set up Intelligence on this computer.",
  ),
  unverified: blocked(
    "The Intelligence software failed its integrity check.",
    "repair",
  ),
  // Cancelled is the person's own call stopping, not another command holding the stack.
  cancelled: blocked("Stopped at your request before it finished.", "retry"),
  spawn: couldNotStart,
  // Ran out of time, which on a slow disk or connection is not the same as failing: the cluster and
  // the images it fetched are still there for the retry. Seen at exactly 30 minutes on a Windows VM
  // that was installing OpenBot's packages at the same time.
  timeout: blocked(
    "Intelligence took too long to start, so OpenBot stopped waiting. What it already downloaded is kept, so trying again picks up from there.",
    "restart-intelligence",
  ),
  "unexpected-exit": couldNotStart,
  "invalid-stack": blocked(contract),
  "output-limit": blocked(contract),
  "invalid-json": blocked(contract),
  "unsupported-version": blocked(contract),
  "unexpected-command": blocked(contract),
  "invalid-status": blocked(contract),
  "missing-stack": blocked(contract),
  "unsafe-endpoint": blocked(contract),
  "contract-mismatch": blocked(contract),
  "invalid-acceptance": blocked(
    "The evaluation agreement could not be accepted.",
    "retry",
  ),
};

function intelligenceRow(
  intelligence: ReadinessInput["intelligence"],
  now: number,
): ReadinessRow {
  if (intelligence === null) {
    return {
      state: "unknown",
      said: "Intelligence has not been checked yet.",
    };
  }
  if (typeof intelligence === "string") return failureRows[intelligence];
  // Same positive match as the chat gate: only an exactly good report is ready.
  const good = chatGate({
    intelligence,
    openBot: "connected",
    provider: "validated",
  }).open;
  if (good) {
    return {
      state: "ready",
      said: licenceExpiresSoon(intelligence, now)
        ? "Intelligence is ready. Its evaluation licence expires within 5 days."
        : "Intelligence is ready.",
    };
  }
  if (intelligence.reason !== null) return reasonRows[intelligence.reason];
  if (intelligence.outcome !== "completed") return couldNotStart;
  const licence = intelligence.licence;
  if (licence !== "valid" && licence !== "unknown") return licenceRows[licence];
  if (intelligence.readiness === "starting") {
    return { state: "unknown", said: "Intelligence is starting." };
  }
  if (intelligence.readiness === "stopped") {
    return blocked("Intelligence is stopped.", "start-intelligence");
  }
  if (intelligence.readiness === "degraded") {
    return blocked(
      "Intelligence is running but not healthy.",
      "restart-intelligence",
    );
  }
  return {
    state: "unknown",
    said: "Intelligence started. Its licence and readiness are not reported yet.",
  };
}

/**
 * The CLI's Docker reasons are evidence about the runtime, used only when the window's own probe
 * has no answer. A probe that says Docker is running is not overridden.
 */
function runtimeRow(
  runtime: ReadinessInput["runtime"],
  intelligence: ReadinessInput["intelligence"],
): ReadinessRow {
  if (runtime === "running") {
    return { state: "ready", said: "Docker Desktop is running." };
  }
  const notRunning = blocked("Docker Desktop is not running.", "retry");
  if (runtime === "not-running") return notRunning;
  const reason =
    intelligence !== null && typeof intelligence !== "string"
      ? intelligence.reason
      : null;
  if (reason === "docker-unavailable") return notRunning;
  if (reason === "unsupported-engine") {
    return blocked("This Docker setup is not supported.");
  }
  return { state: "unknown", said: "Docker Desktop has not been checked." };
}

export function localReadiness(input: ReadinessInput): Readiness {
  return {
    runtime: runtimeRow(input.runtime, input.intelligence),
    intelligence: intelligenceRow(input.intelligence, input.now ?? Date.now()),
    openBot:
      input.openBot === "connected"
        ? { state: "ready", said: "OpenBot is connected to Intelligence." }
        : input.openBot === "not-connected"
          ? blocked(
              "OpenBot is not connected to Intelligence.",
              "restart-openbot",
            )
          : {
              state: "unknown",
              said: "OpenBot's connection has not been checked.",
            },
    provider:
      input.provider === "validated"
        ? { state: "ready", said: "The AI provider key is valid." }
        : input.provider === "invalid"
          ? blocked("The AI provider rejected the key.")
          : {
              state: "unknown",
              said: "The AI provider key has not been checked.",
            },
  };
}
