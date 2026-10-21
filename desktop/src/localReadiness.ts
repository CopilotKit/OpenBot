/**
 * What the window can honestly say about each part of the local setup.
 *
 * Four rows, one per independent fact: the container runtime, Intelligence, OpenBot's connection
 * to it, and the AI provider key. Every sentence here is static. Nothing from the CLI is shown,
 * because the native boundary passes on only enumerated categories.
 *
 * Unknown is never shown as ready. CLI v1 cannot state readiness or licence, so today the
 * Intelligence row is never "ready".
 */
import {
  type ChatGateInput,
  chatGate,
  type LocalFailure,
  type LocalReason,
} from "./localEvalCli";

export type ReadinessState = "ready" | "blocked" | "unknown";
export type ReadinessAction =
  | "retry"
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
const contract = "OpenBot does not understand this CLI's reply.";
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
    "Intelligence cannot start on this Docker setup.",
  ),
  "docker-unavailable": blocked(
    "Intelligence cannot start until Docker Desktop is running.",
    "retry",
  ),
  "port-unavailable": blocked("A port Intelligence needs is in use.", "retry"),
  "local-command-busy": busy,
  "local-command-failed": couldNotStart,
  unrecognized: couldNotStart,
};

const failureRows: Record<LocalFailure, ReadinessRow> = {
  unavailable: blocked("This build does not include the Intelligence CLI."),
  unverified: blocked(
    "The Intelligence CLI failed its integrity check.",
    "repair",
  ),
  // Cancelled is the person's own call stopping, not another command holding the stack.
  cancelled: blocked(
    "The Intelligence command was stopped before it finished.",
    "retry",
  ),
  spawn: couldNotStart,
  timeout: couldNotStart,
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
};

function intelligenceRow(
  intelligence: ReadinessInput["intelligence"],
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
  if (good) return { state: "ready", said: "Intelligence is ready." };
  if (intelligence.reason !== null) return reasonRows[intelligence.reason];
  if (intelligence.outcome !== "completed") return couldNotStart;
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
    intelligence: intelligenceRow(input.intelligence),
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
