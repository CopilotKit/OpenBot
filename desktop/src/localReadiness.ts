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
  type PodmanPlan,
  type Shortfall,
} from "./localEvalCli";

/**
 * A back end ready on the release it has, with an update it did not finish: what it runs, what did
 * not finish, and that the next Start tries again. Only what the CLI recorded: a download that did
 * not finish is said as one, and no cause is guessed.
 */
export function onInstalledReleaseSaid({
  update,
}: NonNullable<ReturnType<typeof onInstalledRelease>>): string {
  // The releases are in the log (`log_update_due`): a person reads what happened and what's next.
  const unfinished = update.stoppedDownloading
    ? "The OpenBot update didn't finish downloading"
    : "The OpenBot update didn't finish";
  return `${unfinished}, so OpenBot is running the version it had. It tries again the next time it starts.`;
}

export type ReadinessState = "ready" | "blocked" | "unknown";
export type ReadinessAction =
  | "retry"
  | "start-intelligence"
  | "restart-intelligence"
  | "restart-openbot"
  | "sign-in"
  | "repair"
  | "start-fresh";

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

/*
 * In the person's words: what happened, then what to do. The back end, its CLI, Podman's machine
 * and k3s are the log's business, and the logs a person can copy from the same card. A product is
 * named only where the person has to act in it: Docker Desktop's settings, a Podman command.
 */
const unavailableHere =
  "This version of OpenBot can't run on this computer. Check for an update to OpenBot.";
const contract =
  "OpenBot got an answer it couldn't read. Retry. If it happens again, copy the logs below.";
const couldNotStart = blocked(
  "OpenBot couldn't start.",
  "restart-intelligence",
);
const busy = blocked(
  "OpenBot is still busy with another step. Wait a moment, then Retry.",
  "retry",
);
// The three ways a back end command ends with no answer OpenBot can act on, each said apart, so
// the card is never only "could not start". The CLI's own words go to OpenBot's log, not here.
const failedPartway = blocked(
  "Setup stopped partway through with an error. Retry. If it stops again, copy the logs below.",
  "restart-intelligence",
);
const couldNotRun = blocked(
  "OpenBot couldn't run part of its own software. Retry.",
  "restart-intelligence",
);
const quitUnexplained = blocked(
  "Part of OpenBot stopped without saying why. Retry. If it stops again, copy the logs below.",
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
  disk: "free disk space",
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
 * Start, as the CLI measures it, or in total, before it. A disk that is short is never "out of disk
 * space": Windows F was told so with 13 GB free.
 */
function shortfallSaid(
  shortfall: Shortfall,
  needs: Record<Resource, string>,
  then: string,
): string {
  // Docker Desktop is where the person raises Docker's limits, so it is named. OpenBot's own Podman
  // machine is OpenBot to them, except in the command that raises its limits.
  const engine = shortfall.podman ? "OpenBot" : "Docker Desktop";
  // "OpenBot has 2 CPUs. It needs 4." rather than naming OpenBot twice.
  const needsWho = shortfall.podman ? "It needs" : "OpenBot needs";
  const short = (["cpu", "memory", "disk"] as const).filter(
    (resource) => shortfall[resource],
  );
  // Space was freed, and k3s still says the disk is low for a few minutes after.
  if (shortfall.recovering && short.length === 0) {
    return `OpenBot is recovering from low disk space. Wait a few minutes, then ${then}.`;
  }
  if (short.length === 0) {
    const fix = shortfall.podman
      ? "Stop your Podman machine, raise them with podman machine set, start it again"
      : "Raise them in Docker Desktop > Settings > Resources";
    return `${shortfall.podman ? "This computer doesn't give OpenBot" : "Docker Desktop doesn't give OpenBot"} enough CPUs, memory or disk space. ${fix}, then ${then}.`;
  }
  // The drive under OpenBot's machine ran short, on Windows: said as the person sees it in File
  // Explorer, and as the first screen says it. "OpenBot has 13.2 GB of free disk" read badly.
  if (
    short.length === 1 &&
    shortfall.disk &&
    shortfall.freeOnDrive &&
    shortfall.drive &&
    shortfall.diskGb &&
    !shortfall.nearlyFull
  ) {
    return `This computer has ${shortfall.diskGb} GB of free space on drive ${shortfall.drive}, and OpenBot needs ${needed.disk}. Free up some space, then ${then}.`;
  }
  const fix = shortfall.podman
    ? podmanFix(short, shortfall)
    : `Raise the ${short.length === 1 ? `${limitName[short[0]]} limit` : "limits"} in Docker Desktop > Settings > Resources${shortfall.disk ? ", or free space in Docker" : ""}`;
  // OpenBot's own check after a start that failed: k3s itself is short of disk.
  if (shortfall.nearlyFull && short.length === 1) {
    const free = shortfall.diskGb
      ? ` ${shortfall.podman ? "It" : engine} has ${shortfall.diskGb} GB free${shortfall.diskSizeGb ? ` of ${shortfall.diskSizeGb} GB` : ""}.`
      : "";
    const needs40 =
      shortfall.diskGb && Number(shortfall.diskGb) < 40
        ? ` ${needsWho} ${needed.disk}.`
        : "";
    return `OpenBot is nearly out of disk space.${free}${needs40} ${fix}, then ${then}.`;
  }
  // The CLI's own numbers, when its error gave one for every resource that is short.
  const measured: Record<Resource, string | undefined> = {
    // The CLI counts every CPU the engine has (its `NCPU`), not the ones left free.
    cpu: shortfall.cpus && `${shortfall.cpus} CPUs`,
    memory: shortfall.memoryGb && `${shortfall.memoryGb} GB of free memory`,
    disk: shortfall.diskGb && `${shortfall.diskGb} GB of free disk space`,
  };
  const has = short.map((resource) => measured[resource]);
  // After "OpenBot is nearly out of disk space.", OpenBot's own machine is "it".
  const who = shortfall.podman && shortfall.nearlyFull ? "It" : engine;
  const said = has.every((said) => said !== undefined)
    ? `${who} has ${listed(has as string[])}. ${needsWho} ${
        short.length === 1
          ? needed[short[0]]
          : listed(short.map((resource) => neededFully[resource]))
      }.`
    : `${engine} doesn't have enough ${listed(short.map((resource) => resourceName[resource]))}. ${needsWho} ${listed(short.map((resource) => needs[resource]))}.`;
  const full = shortfall.nearlyFull
    ? "OpenBot is nearly out of disk space. "
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
    `free up space on ${shortfall.drive ? `drive ${shortfall.drive}` : "the drive OpenBot is installed on"}`;
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
  cpu: "4 CPUs",
  memory: "4 GB of free memory",
  disk: "40 GB of free disk space",
};

/**
 * The CLI's resource check at Start: 4 CPUs in all, and 4 GB of free memory and 40 GB of free disk
 * with OpenBot's own containers running.
 */
export function resourcesShortSaid(shortfall: Shortfall): string {
  return shortfallSaid(
    shortfall,
    {
      cpu: "4 CPUs",
      memory: "4 GB of free memory",
      disk: "40 GB free",
    },
    "Retry",
  );
}

/** MiB as the GB a person reads: 6144 is "6", 3277 is "3.2". */
function gb(mib: number): string {
  const tenths = Math.floor((mib / 1024) * 10) / 10;
  return tenths.toFixed(1).replace(/\.0$/, "");
}

/**
 * What happened, when setup found the person's Podman machine too small and OpenBot knows its size
 * (`podmanMachinePlan`): its own size, beside what OpenBot needs. What to do is the fix card's
 * (`PodmanTooSmall`), so it is not said here. CPUs are the machine's in all, as the CLI counts them;
 * memory is what is free in it.
 */
export function podmanTooSmallSaid(
  shortfall: Shortfall,
  plan: PodmanPlan,
): string {
  const has = "Your Podman machine has";
  if (shortfall.disk) {
    const short = (["cpu", "memory", "disk"] as const).filter(
      (resource) => shortfall[resource],
    );
    return `Your Podman machine doesn't have enough ${listed(short.map((resource) => resourceName[resource]))} for OpenBot.`;
  }
  if (shortfall.cpu && shortfall.memory) {
    return shortfall.memoryGb
      ? `${has} ${plan.cpus} CPUs and ${shortfall.memoryGb} GB of free memory. OpenBot needs 4 CPUs and 4 GB of free memory.`
      : `${has} ${plan.cpus} CPUs and ${gb(plan.memoryMib)} GB of memory. OpenBot needs 4 CPUs and 4 GB of free memory.`;
  }
  if (shortfall.cpu) return `${has} ${plan.cpus} CPUs. OpenBot needs 4.`;
  return shortfall.memoryGb
    ? `${has} ${gb(plan.memoryMib)} GB of memory, and ${shortfall.memoryGb} GB of it is free. OpenBot needs 4 GB free.`
    : `${has} ${gb(plan.memoryMib)} GB of memory. OpenBot needs 4 GB free.`;
}

/** What OpenBot gives the machine, in words: "6 CPUs and 8 GB of memory". */
export function podmanRaisedSaid(plan: PodmanPlan): string {
  const raised = [
    plan.toCpus > plan.cpus && `${plan.toCpus} CPUs`,
    plan.toMemoryMib > plan.memoryMib && `${gb(plan.toMemoryMib)} GB of memory`,
  ].filter((said): said is string => Boolean(said));
  return listed(raised);
}

/**
 * The three commands that make the machine bigger by hand, for when OpenBot can't: stop it, set
 * what is short, start it. Named by the machine, since `podman machine set` without a name changes
 * `podman-machine-default`, which may not be the one OpenBot uses.
 */
export function podmanResizeCommands(
  shortfall: Shortfall,
  plan: PodmanPlan,
): { stop: string; set: string; start: string } {
  const flags = [
    plan.toCpus > plan.cpus && `--cpus ${plan.toCpus}`,
    plan.toMemoryMib > plan.memoryMib && `--memory ${plan.toMemoryMib}`,
    shortfall.disk && podmanFlag.disk,
  ].filter(Boolean);
  return {
    stop: `podman machine stop ${plan.machine}`,
    set: `podman machine set ${flags.join(" ")} ${plan.machine}`,
    start: `podman machine start ${plan.machine}`,
  };
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
  "authentication-required": blocked("Sign in to OpenBot.", "sign-in"),
  // Acceptance is an explicit step of its own; retrying start cannot satisfy it.
  "eula-acceptance-required": blocked(
    "The license agreement hasn't been accepted yet.",
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
    "OpenBot can't run on this computer as it's set up.",
  ),
  // The CLI could not reach Docker's API: stopped, or running and unreachable, which it cannot tell
  // apart. Retry starts it, or stops and starts one that runs and does not answer.
  "docker-unavailable": blocked(
    "OpenBot can't reach the software it runs on. Retry to start it again.",
    "retry",
  ),
  "port-unavailable": blocked(
    "Another app is using a network port OpenBot needs. Quit that app, then Retry.",
    "retry",
  ),
  "local-command-busy": busy,
  "local-command-failed": failedPartway,
  // OpenBot always approves the connection it asks for, so this is the CLI asking for more.
  "confirmation-required": blocked(
    "Setup stopped to ask something OpenBot can't answer. Copy the logs below and ask for help.",
  ),
  // Reasons only `local login` gives; a status that gave one is still blocked, never ready.
  "dashboard-unavailable": blocked(
    "OpenBot isn't answering yet. Wait a moment, then Retry.",
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
  // Box I: OpenBot's machine was made again, and the backend and its data went with the old one.
  // Honest about what is gone, and the one way on.
  "stack-lost": blocked(
    "OpenBot's saved data on this computer is gone, with your Bots and conversations. Start fresh to set OpenBot up again. Your sign-in and AI connection stay.",
    "start-fresh",
  ),
  unrecognized: couldNotStart,
};

// A licence the CLI verified as anything but valid blocks, however ready Intelligence is.
const licenceRows: Record<
  Exclude<LocalLicence, "valid" | "unknown">,
  ReadinessRow
> = {
  expired: blocked("The evaluation licence has expired."),
  missing: blocked("OpenBot has no evaluation licence on this computer."),
  invalid: blocked("The evaluation licence is not valid."),
  "organization-mismatch": blocked(
    "The licence belongs to a different organization.",
  ),
};

const failureRows: Record<LocalFailure, ReadinessRow> = {
  unavailable: blocked(
    "This version of OpenBot can't finish setting up on this computer. Check for an update to OpenBot.",
  ),
  unverified: blocked(
    "Part of OpenBot didn't pass its download check. Repair the installation to download it again.",
    "repair",
  ),
  // Cancelled is the person's own call stopping, not another command holding the stack.
  cancelled: blocked("Stopped at your request before it finished.", "retry"),
  spawn: couldNotRun,
  // Ran out of time, which on a slow disk or connection is not the same as failing: the cluster and
  // the images it fetched are still there for the retry. Seen at exactly 30 minutes on a Windows VM
  // that was installing OpenBot's packages at the same time.
  timeout: blocked(
    "OpenBot took too long to set up, so it stopped waiting. What it already downloaded is kept, so Retry picks up from there.",
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
    "OpenBot can't run on your Podman machine as it's set up. Stop your Podman machine, run podman machine set --rootful, start it again, then Retry.",
    "retry",
  ),
  // No new bytes for three minutes. What arrived is kept, and the next download continues from it.
  "download-stalled": blocked(
    "The download stopped. Retry continues where it left off.",
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
      said: "OpenBot hasn't been checked yet.",
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
        ? "OpenBot is ready. Its evaluation licence expires within 5 days."
        : "OpenBot is ready.",
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
    return { state: "unknown", said: "OpenBot is starting." };
  }
  if (intelligence.readiness === "stopped") {
    return blocked("OpenBot's services are stopped.", "start-intelligence");
  }
  if (intelligence.readiness === "degraded") {
    // OpenBot's check of a back end that runs but does not answer: a full disk, or one recovering.
    if (intelligence.shortfall) {
      return blocked(
        resourcesShortSaid(intelligence.shortfall),
        "restart-intelligence",
      );
    }
    return blocked(
      "OpenBot is running but not working properly. Retry to start it again.",
      "restart-intelligence",
    );
  }
  return {
    state: "unknown",
    said: "OpenBot started, and hasn't said yet whether it's ready.",
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
    return { state: "ready", said: "The software OpenBot runs on is running." };
  }
  const notRunning = blocked(
    "The software OpenBot runs on isn't running.",
    "retry",
  );
  if (runtime === "not-running") return notRunning;
  const reason =
    intelligence !== null && typeof intelligence !== "string"
      ? intelligence.reason
      : null;
  if (reason === "docker-unavailable") {
    return blocked("OpenBot can't reach the software it runs on.", "retry");
  }
  if (reason === "unsupported-engine") {
    return blocked("OpenBot can't run on this computer as it's set up.");
  }
  return {
    state: "unknown",
    said: "The software OpenBot runs on hasn't been checked yet.",
  };
}

export function localReadiness(input: ReadinessInput): Readiness {
  return {
    runtime: runtimeRow(input.runtime, input.intelligence),
    intelligence: intelligenceRow(input.intelligence, input.now ?? Date.now()),
    openBot:
      input.openBot === "connected"
        ? { state: "ready", said: "OpenBot is connected to its services." }
        : input.openBot === "not-connected"
          ? blocked(
              "OpenBot isn't connected to its services. Restart OpenBot.",
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
