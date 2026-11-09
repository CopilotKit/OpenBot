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
  onInstalledRelease,
  type Shortfall,
} from "./localEvalCli";

/**
 * A back end ready on the release it has, with an update it did not finish: what it runs, what did
 * not finish, and that the next Start tries again. Only what the CLI recorded: a download that did
 * not finish is said as one, and no cause is guessed.
 */
export function onInstalledReleaseSaid({
  release,
  update,
}: NonNullable<ReturnType<typeof onInstalledRelease>>): string {
  const unfinished = update.stoppedDownloading
    ? `Downloading ${update.to} did not finish`
    : `The update to ${update.to} did not finish`;
  return `The back end is running ${release}. ${unfinished}, so OpenBot tries again the next time it starts.`;
}

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
  /** The container engine, Docker or Podman, as probed by the window. */
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
  "The back end is not available on this computer or release.";
const contract = "OpenBot did not understand its back end's reply.";
const couldNotStart = blocked(
  "The back end could not start.",
  "restart-intelligence",
);
const busy = blocked("The back end is still running another command.", "retry");
// The three ways a back end command ends with no answer OpenBot can act on, each said apart, so
// the card is never only "could not start". The CLI's own words go to OpenBot's log, not here.
const failedPartway = blocked(
  "The back end stopped with an error partway through. OpenBot's log has the details.",
  "restart-intelligence",
);
const couldNotRun = blocked(
  "OpenBot could not run the back end's software.",
  "restart-intelligence",
);
const quitUnexplained = blocked(
  "The back end's software quit without saying why. OpenBot's log has the details.",
  "restart-intelligence",
);

type Resource = "cpu" | "memory" | "disk";

function listed(words: string[]): string {
  return words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const resourceName: Record<Resource, string> = {
  cpu: "CPUs",
  memory: "memory",
  disk: "disk space",
};
const limitName: Record<Resource, string> = {
  cpu: "CPU",
  memory: "memory",
  disk: "disk",
};
// What `podman machine set` raises each to, for the minimum below.
const podmanFlag: Record<Resource, string> = {
  cpu: "--cpus 6",
  memory: "--memory 8192",
  disk: "--disk-size 160",
};

/**
 * Which resource is short and where to raise it. `needs` is what OpenBot needs of each: free, at
 * Start, as the CLI measures it, or in total, before it. Disk alone is "out of disk space".
 */
function shortfallSaid(
  shortfall: Shortfall,
  needs: Record<Resource, string>,
  then: string,
): string {
  const engine = shortfall.podman ? "Podman" : "Docker";
  const short = (["cpu", "memory", "disk"] as const).filter(
    (resource) => shortfall[resource],
  );
  // Space was freed, and k3s still says the disk is low for a few minutes after.
  if (shortfall.recovering && short.length === 0) {
    return `The back end is recovering from low disk space. Wait a few minutes, then ${then}.`;
  }
  if (short.length === 0) {
    const fix = shortfall.podman
      ? "Stop your Podman machine, raise them with podman machine set, start it again"
      : "Raise them in Docker Desktop > Settings > Resources";
    return `${engine} doesn't have enough CPUs, memory or disk space for the back end. ${fix}, then ${then}.`;
  }
  const fix = shortfall.podman
    ? podmanFix(short, shortfall)
    : `Raise the ${short.length === 1 ? `${limitName[short[0]]} limit` : "limits"} in Docker Desktop > Settings > Resources${shortfall.disk ? ", or free space in Docker" : ""}`;
  // OpenBot's own check after a start that failed: k3s itself is short of disk.
  if (shortfall.nearlyFull && short.length === 1) {
    const free = shortfall.diskGb
      ? ` ${engine} has ${shortfall.diskGb} GB free${shortfall.diskSizeGb ? ` of ${shortfall.diskSizeGb} GB` : ""}.`
      : "";
    const needs40 =
      shortfall.diskGb && Number(shortfall.diskGb) < 40
        ? ` OpenBot needs ${needed.disk}.`
        : "";
    return `The back end's disk is nearly full.${free}${needs40} ${fix}, then ${then}.`;
  }
  // The CLI's own numbers, when its error gave one for every resource that is short.
  const measured: Record<Resource, string | undefined> = {
    cpu: shortfall.cpus && `${shortfall.cpus} free CPUs`,
    memory: shortfall.memoryGb && `${shortfall.memoryGb} GB of free memory`,
    disk: shortfall.diskGb && `${shortfall.diskGb} GB of free disk`,
  };
  const has = short.map((resource) => measured[resource]);
  const said = has.every((said) => said !== undefined)
    ? `${engine} has ${listed(has as string[])}. OpenBot needs ${
        short.length === 1
          ? needed[short[0]]
          : listed(short.map((resource) => neededFully[resource]))
      }.`
    : short.length === 1 && short[0] === "disk"
      ? `${engine} is out of disk space. OpenBot needs ${needs.disk}.`
      : `${engine} doesn't have enough ${listed(short.map((resource) => resourceName[resource]))}. OpenBot needs ${listed(short.map((resource) => needs[resource]))}.`;
  const full = shortfall.nearlyFull
    ? "The back end's disk is nearly full. "
    : "";
  return `${full}${said} ${fix}, then ${then}.`;
}

/**
 * Where Podman raises what is short. On Windows its machine runs in WSL, where `podman machine set`
 * refuses to change its disk ("changing disk size not supported for WSL machines"), and the disk
 * is a sparse virtual disk on `drive`, so space is freed on that drive instead.
 */
function podmanFix(short: Resource[], shortfall: Shortfall): string {
  const raised = short.filter(
    (resource) => !(shortfall.wsl && resource === "disk"),
  );
  const set =
    raised.length > 0 &&
    `Stop your Podman machine, run podman machine set ${raised.map((resource) => podmanFlag[resource]).join(" ")}, start it again`;
  const freed =
    shortfall.wsl &&
    short.includes("disk") &&
    `free space on the drive that holds OpenBot's engine${shortfall.drive ? ` (${shortfall.drive})` : ""}`;
  if (set && freed) return `${set}, and ${freed}`;
  if (freed) return freed.charAt(0).toUpperCase() + freed.slice(1);
  return set || "";
}

// What the CLI requires free, beside its own numbers: "Docker has 0 GB of free disk. OpenBot
// needs 40 GB."
const needed: Record<Resource, string> = {
  cpu: "4",
  memory: "4 GB",
  disk: "40 GB",
};
const neededFully: Record<Resource, string> = {
  cpu: "4 free CPUs",
  memory: "4 GB of free memory",
  disk: "40 GB of free disk",
};

/**
 * The CLI's resource check at Start: 4 free CPUs, 4 GB of free memory and 40 GB of free disk, with
 * OpenBot's own containers running.
 */
export function resourcesShortSaid(shortfall: Shortfall): string {
  return shortfallSaid(
    shortfall,
    {
      cpu: "4 free CPUs",
      memory: "4 GB of free memory",
      disk: "40 GB free",
    },
    "Retry",
  );
}

/** OpenBot's own check before Start: the engine's totals, with room for its own containers. */
export function engineTooSmallSaid(shortfall: Shortfall): string {
  return shortfallSaid(
    shortfall,
    { cpu: "4 CPUs", memory: "4 GB of memory", disk: "40 GB free" },
    "Try again",
  );
}

// Compiler-enforced: a new upstream reason or failure breaks the build here.
const reasonRows: Record<LocalReason, ReadinessRow> = {
  "authentication-required": blocked("Sign in to CopilotKit.", "sign-in"),
  // Acceptance is an explicit step of its own; retrying start cannot satisfy it.
  "eula-acceptance-required": blocked(
    "The license agreement has not been accepted.",
  ),
  "eula-unavailable": blocked(
    "The license agreement could not be shown.",
    "retry",
  ),
  "eula-declined": blocked("The license agreement was declined."),
  "release-unavailable": blocked(unavailableHere),
  "feature-disabled": blocked(unavailableHere),
  "unsupported-platform": blocked(unavailableHere),
  "incompatible-release": blocked(unavailableHere),
  "update-recovery-required": blocked(unavailableHere),
  // The runtime row carries the Docker detail. Here Intelligence is simply blocked behind it.
  "unsupported-engine": blocked(
    "The back end cannot run on this computer's current setup.",
  ),
  "docker-unavailable": blocked(
    "The back end cannot start until the software it runs on is running.",
    "retry",
  ),
  "port-unavailable": blocked("A port the back end needs is in use.", "retry"),
  "local-command-busy": busy,
  "local-command-failed": failedPartway,
  // OpenBot always approves the connection it asks for, so this is the CLI asking for more.
  "confirmation-required": blocked(
    "The back end asked for a confirmation OpenBot cannot give.",
  ),
  // Reasons only `local login` gives; a status that gave one is still blocked, never ready.
  "dashboard-unavailable": blocked(
    "The back end is not responding yet.",
    "retry",
  ),
  "browser-open-failed": blocked("Your browser did not open.", "retry"),
  // Said with the resource when the report names it: see `intelligenceRow`.
  "resources-short": blocked(
    resourcesShortSaid({
      podman: false,
      cpu: false,
      memory: false,
      disk: false,
    }),
    "retry",
  ),
  unrecognized: couldNotStart,
};

// A licence the CLI verified as anything but valid blocks, however ready Intelligence is.
const licenceRows: Record<
  Exclude<LocalLicence, "valid" | "unknown">,
  ReadinessRow
> = {
  expired: blocked("The evaluation licence has expired."),
  missing: blocked("The back end has no evaluation licence."),
  invalid: blocked("The evaluation licence is not valid."),
  "organization-mismatch": blocked(
    "The licence belongs to a different organization.",
  ),
};

const failureRows: Record<LocalFailure, ReadinessRow> = {
  unavailable: blocked(
    "This version of OpenBot cannot set up its back end on this computer.",
  ),
  unverified: blocked(
    "The back end's software failed its integrity check.",
    "repair",
  ),
  // Cancelled is the person's own call stopping, not another command holding the stack.
  cancelled: blocked("Stopped at your request before it finished.", "retry"),
  spawn: couldNotRun,
  // Ran out of time, which on a slow disk or connection is not the same as failing: the cluster and
  // the images it fetched are still there for the retry. Seen at exactly 30 minutes on a Windows VM
  // that was installing OpenBot's packages at the same time.
  timeout: blocked(
    "The back end took too long to start, so OpenBot stopped waiting. What it already downloaded is kept, so trying again picks up from there.",
    "restart-intelligence",
  ),
  "unexpected-exit": quitUnexplained,
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
  // OpenBot runs on a Podman machine without root, and Intelligence needs root. Switching it is
  // the person's call. OpenBot stays in the storage its database is in, and Intelligence runs on
  // the machine's rootful engine.
  "rootless-podman": blocked(
    "The back end needs Podman in rootful mode. Stop your Podman machine, run podman machine set --rootful, then start it again.",
    "retry",
  ),
  // No new bytes for three minutes. What arrived is kept, and the next download continues from it.
  "download-stalled": blocked(
    "The back end download stopped. Retry continues where it left off.",
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
      said: "The back end has not been checked yet.",
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
    const kept = onInstalledRelease(intelligence);
    if (kept) return { state: "ready", said: onInstalledReleaseSaid(kept) };
    return {
      state: "ready",
      said: licenceExpiresSoon(intelligence, now)
        ? "The back end is ready. Its evaluation licence expires within 5 days."
        : "The back end is ready.",
    };
  }
  if (intelligence.reason === "resources-short" && intelligence.shortfall) {
    return blocked(resourcesShortSaid(intelligence.shortfall), "retry");
  }
  if (intelligence.reason !== null) return reasonRows[intelligence.reason];
  if (intelligence.outcome !== "completed") return couldNotStart;
  const licence = intelligence.licence;
  if (licence !== "valid" && licence !== "unknown") return licenceRows[licence];
  if (intelligence.readiness === "starting") {
    return { state: "unknown", said: "The back end is starting." };
  }
  if (intelligence.readiness === "stopped") {
    return blocked("The back end is stopped.", "start-intelligence");
  }
  if (intelligence.readiness === "degraded") {
    return blocked(
      "The back end is running but not healthy.",
      "restart-intelligence",
    );
  }
  return {
    state: "unknown",
    said: "The back end started. Its licence and readiness are not reported yet.",
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
    return { state: "ready", said: "The container engine is running." };
  }
  const notRunning = blocked("The container engine is not running.", "retry");
  if (runtime === "not-running") return notRunning;
  const reason =
    intelligence !== null && typeof intelligence !== "string"
      ? intelligence.reason
      : null;
  if (reason === "docker-unavailable") return notRunning;
  if (reason === "unsupported-engine") {
    return blocked("This container engine setup is not supported.");
  }
  return {
    state: "unknown",
    said: "The container engine has not been checked.",
  };
}

export function localReadiness(input: ReadinessInput): Readiness {
  return {
    runtime: runtimeRow(input.runtime, input.intelligence),
    intelligence: intelligenceRow(input.intelligence, input.now ?? Date.now()),
    openBot:
      input.openBot === "connected"
        ? { state: "ready", said: "OpenBot is connected to its back end." }
        : input.openBot === "not-connected"
          ? blocked(
              "OpenBot is not connected to its back end.",
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
