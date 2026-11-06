import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import {
  AUTOMATIC_LEARNING_CONTAINER_ID,
  type LearningAutoAssignState,
} from "@openbot/shared/learning";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import {
  askWhileIntelligenceStarts,
  type StartupClock,
} from "../intelligence-startup";
import type { ContainerCreation } from "./ensure-container";
import type { LearningSettingsStore } from "./settings";

/**
 * What asking Intelligence about one container found. `learning_off`: Intelligence answered and has
 * no Learning routes at all, which is Learning switched off in its deployment, not a failure to reach it.
 */
export type ContainerProbe =
  | "present"
  | "absent"
  | "not_entitled"
  | "learning_off"
  | "unavailable";

/** The HTTP status and Intelligence error code a project-key Learning request failed with. */
function requestFailure(error: unknown): { status?: number; code?: string } {
  if (error === null || typeof error !== "object") return {};
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
  };
}

/**
 * Read a refusal from Intelligence's project-key Learning routes (`/api/v1/learning/containers/...`).
 *
 * Intelligence with Learning switched off registers none of them, so it answers 404 with its
 * catch-all `ROUTE_NOT_FOUND`: Learning is off there, which the person who can turn it on needs to
 * hear, rather than that Intelligence could not be reached.
 */
export function classifyLearningRouteError(error: unknown): ContainerProbe {
  const { status, code } = requestFailure(error);
  if (status === 404 && code === "ROUTE_NOT_FOUND") return "learning_off";
  if (code === "LEARNING_CONTAINER_NOT_FOUND") return "absent";
  if (code === "LEARNING_NOT_ENABLED") return "not_entitled";
  return "unavailable";
}

/**
 * Ask whether `containerId` exists in the project the runtime key belongs to, by reading it on that
 * key (`GET /api/v1/learning/containers/:id`). The read is scoped to the key's own project and has no
 * side effect, and its refusal carries Intelligence's own code: Learning switched off, a missing
 * container, or Learning not licensed.
 */
export async function probeLearningContainer(
  client: {
    experimental: {
      learning: Pick<
        CopilotKitIntelligence["experimental"]["learning"],
        "getLearningContainer"
      >;
    };
  },
  containerId: string,
  timeoutMs = 5_000,
): Promise<ContainerProbe> {
  try {
    await client.experimental.learning.getLearningContainer({
      containerId,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "present";
  } catch (error) {
    return classifyLearningRouteError(error);
  }
}

/** A client holding only a runtime key, for helpers that run without the server. */
export function runtimeKeyClient(
  apiUrl: string,
  apiKey: string,
  wsUrl?: string,
) {
  return new CopilotKitIntelligence({
    apiUrl,
    apiKey,
    ...(wsUrl ? { wsUrl } : {}),
  });
}

export type LearningAutoAssign = {
  /** Check now, unless a check is already running, and return what it found. Never throws. */
  check(): Promise<LearningAutoAssignState>;
  /**
   * Admin's "Create it now": try creating it again, whatever earlier attempts found, then check. Never throws; a failure comes back as the state's `createError`.
   */
  createNow(): Promise<LearningAutoAssignState>;
  /** Start a check in the background if none ran within the last `minIntervalMs`. */
  kick(): void;
  /** The last answer, without asking. */
  state(): LearningAutoAssignState;
  /**
   * Check at boot, asking again while Intelligence is still starting (see intelligence-startup.ts),
   * then keep checking every `retryMs` until there is nothing left to do.
   */
  start(): void;
  stop(): void;
};

/** How often a deployment with no container asks again, so one created later is picked up. */
const RETRY_MS = 10 * 60_000;
/** The shortest gap between background checks started by page loads and turns. */
const MIN_INTERVAL_MS = 60_000;

/**
 * Assign this project's `openbot` Learning container as the default when nobody has chosen one.
 *
 * Automatic Learning is on by default, but it collects and delivers nothing until a container is
 * assigned, and assigning one used to take a helper script or a trip to Admin. This closes that gap
 * for every deployment whose Intelligence project already has the container:
 *
 * - It never overrides a choice. A saved Admin setting of any kind, including a saved off, and a
 *   container named in the environment both mean there is nothing to do.
 * - It creates a missing container through `create`, with the runtime key (learning/ensure-container.ts),
 *   once per process unless Admin asks again. When that fails it says what to do instead, once, in
 *   the log and on the Admin page.
 * - It is safe on many replicas: the write is a conditional insert, so the first one wins and the
 *   rest see a saved setting. Only the winner writes the audit row.
 * - It never blocks startup or a turn. Every failure is logged once per kind and tried again later.
 * - It waits out an Intelligence that is still starting at boot: while the boot check finds it
 *   unavailable it asks again, quietly, and says it could not be asked only if that is still so
 *   when the startup window closes.
 */
export function createLearningAutoAssign(options: {
  /** False when the operator switched this off or the environment names a container. */
  enabled: boolean;
  store: Pick<LearningSettingsStore, "saved" | "adoptDefault">;
  probe: (containerId: string) => Promise<ContainerProbe>;
  /** Create the missing container with the runtime key. Absent in tests that only probe. */
  create?: () => Promise<ContainerCreation>;
  /** What an operator does when the container is absent and could not be created here. */
  instructions?: string;
  audit?: AuditStore;
  containerId?: string;
  retryMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** How long the boot check gives a starting Intelligence, and the clock it waits on. */
  startup?: StartupClock;
}): LearningAutoAssign {
  const containerId = options.containerId ?? AUTOMATIC_LEARNING_CONTAINER_ID;
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const log = options.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  let current: LearningAutoAssignState = options.enabled
    ? { state: "pending" }
    : { state: "off" };
  let running: Promise<LearningAutoAssignState> | undefined;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setInterval> | undefined;
  const logged = new Set<string>();
  /** The boot check is waiting for Intelligence to finish starting: "unavailable" is expected, so not logged. */
  let starting = false;
  /** The last check found Intelligence unavailable while that went unsaid, for the boot check to say if it stays so. */
  let unsaid = false;
  let stopped = false;

  const settled = (state: LearningAutoAssignState) =>
    state.state === "off" ||
    state.state === "saved" ||
    state.state === "assigned";
  const once = (kind: string, entry: Record<string, unknown>) => {
    if (logged.has(kind)) return;
    logged.add(kind);
    log({ type: "learning-auto-assign", outcome: kind, containerId, ...entry });
  };

  const instructions =
    options.instructions ??
    `Create a container with ID "${containerId}" in Intelligence; OpenBot assigns it within ${Math.round((options.retryMs ?? RETRY_MS) / 60_000)} minutes.`;
  /** Whether this process already tried `create`: once at boot, again only when Admin asks. */
  let createTried = false;
  let createError: string | undefined;

  /**
   * Create it with the runtime key, once. True when it is there now. `unavailable` when Intelligence
   * could not answer just then (a 5xx, nothing answering), which is not this process's one try: the
   * next check tries again.
   */
  const tryCreate = async (): Promise<boolean | "unavailable"> => {
    if (!options.create || createTried) return false;
    createTried = true;
    try {
      const result = await options.create();
      createError = undefined;
      log({
        type: "learning-auto-assign",
        outcome: result === "created" ? "container_created" : "container_found",
        containerId,
        message:
          result === "created"
            ? `Created the "${containerId}" Learning container with the runtime key.`
            : `The "${containerId}" Learning container is there now.`,
      });
      return true;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "retryable" in error &&
        error.retryable === true
      ) {
        createTried = false;
        return "unavailable";
      }
      createError =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "The container could not be created.";
      once("create_failed", { message: createError });
      return false;
    }
  };

  const sayUnavailable = () =>
    once("unavailable", {
      message:
        "Intelligence could not be asked about the Learning container. OpenBot tries again.",
    });

  const absent = (): LearningAutoAssignState => ({
    state: "absent",
    containerId,
    instructions,
    canCreate: Boolean(options.create),
    ...(createError ? { createError } : {}),
  });

  const run = async (): Promise<LearningAutoAssignState> => {
    unsaid = false;
    if (!options.enabled) return { state: "off" };
    if (await options.store.saved()) return { state: "saved" };
    let found = await options.probe(containerId);
    if (found === "absent") {
      const created = await tryCreate();
      if (created === "unavailable") found = "unavailable";
      else if (created) found = await options.probe(containerId);
    }
    if (found === "absent") {
      once("absent", {
        message: `This Intelligence project has no "${containerId}" Learning container, so Automatic Learning collects nothing yet. ${instructions}`,
      });
      return absent();
    }
    if (found === "not_entitled") {
      once("not_entitled", {
        message:
          "This Intelligence project's plan does not include Learning, so no container was assigned.",
      });
      return { state: "not_entitled" };
    }
    if (found === "learning_off") {
      once("learning_off", {
        message:
          "Learning is switched off in this Intelligence, so Automatic Learning collects nothing. Turn it on in Intelligence (learning.enabled in its Helm chart); OpenBot checks again.",
      });
      return { state: "learning_off" };
    }
    if (found === "unavailable") {
      if (starting) unsaid = true;
      else sayUnavailable();
      return { state: "unavailable" };
    }
    if (!(await options.store.adoptDefault({ containerId })))
      return { state: "saved" };
    if (options.audit)
      await recordAuditEvent(options.audit, {
        eventType: "configuration.changed",
        targetType: "learning",
        initiator: DEPLOYMENT_INITIATOR,
        payload: {
          change: "default_container_assigned_automatically",
          enabled: true,
          defaultContainerId: containerId,
          botMappingCount: 0,
        },
      });
    log({
      type: "learning-auto-assign",
      outcome: "assigned",
      containerId,
      message: `Assigned the "${containerId}" Learning container as the default. Change it in Admin → Automatic Learning.`,
    });
    return { state: "assigned", containerId };
  };

  const check = (): Promise<LearningAutoAssignState> => {
    if (settled(current)) return Promise.resolve(current);
    if (running) return running;
    lastStartedAt = now();
    running = run()
      .catch((error: unknown) => {
        once("error", {
          errorType: error instanceof Error ? error.name : typeof error,
          message:
            "Automatic Learning container assignment failed. OpenBot tries again.",
        });
        return { state: "unavailable" } as LearningAutoAssignState;
      })
      .then((state) => {
        current = state;
        if (settled(state)) stopTimer();
        return state;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  /** The boot check: ask until Intelligence answers or the startup window closes, then say what is still so. */
  const startup = async () => {
    starting = true;
    try {
      await askWhileIntelligenceStarts(
        check,
        (state) => !stopped && state.state === "unavailable",
        options.startup,
      );
    } finally {
      starting = false;
    }
    if (unsaid && current.state === "unavailable") sayUnavailable();
  };

  return {
    check,
    async createNow() {
      // Wait out a check already running, so this attempt is not swallowed by its result.
      if (running) await running;
      // Off, saved or assigned: there is nothing for a container to be assigned to.
      if (settled(current)) return current;
      createTried = false;
      return check();
    },
    kick() {
      if (settled(current) || running) return;
      if (now() - lastStartedAt < minIntervalMs) return;
      void check();
    },
    state: () => current,
    start() {
      if (!options.enabled) return;
      void startup();
      timer = setInterval(() => void check(), options.retryMs ?? RETRY_MS);
      // Never keep the process alive for this alone.
      timer.unref?.();
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}

/**
 * The settings store, nudging automatic assignment whenever a reader finds no default.
 *
 * Every reader of Learning settings goes through here (a turn binding its thread, Admin, skill
 * delivery), so a deployment whose container appeared after boot, or whose boot check could not
 * reach Intelligence, is assigned on its next use rather than only on the timer. The nudge never
 * waits and is rate-limited inside `kick`.
 */
export function withLearningAutoAssign<T extends LearningSettingsStore>(
  store: T,
  autoAssign: LearningAutoAssign,
): T {
  return {
    ...store,
    async read() {
      const settings = await store.read();
      if (settings.enabled && settings.defaultTarget === null)
        autoAssign.kick();
      return settings;
    },
  };
}
