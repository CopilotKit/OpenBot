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
import type { LearningSettingsStore } from "./settings";

/** What asking Intelligence about one container found. */
export type ContainerProbe =
  | "present"
  | "absent"
  | "not_entitled"
  | "unavailable";

/**
 * Read a learned-skills error into whether the container is there.
 *
 * The runtime key cannot list or create Learning containers: Intelligence serves those routes only
 * to a person's session or CLI login. What it can do is read a container's published Skills, and
 * that read is scoped to the key's own project, so it answers the one question this needs without
 * a side effect. A container nobody has published to yet still exists: Intelligence says the
 * revision is missing or delivery is off, not that the container is.
 */
export function classifyProbeError(error: unknown): ContainerProbe {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  if (code === "CONTAINER_NOT_FOUND") return "absent";
  if (
    code === "REVISION_NOT_FOUND" ||
    code === "DELIVERY_DISABLED" ||
    code === "REVISION_REVOKED"
  )
    return "present";
  if (code === "ENTITLEMENT_REQUIRED") return "not_entitled";
  return "unavailable";
}

/** Ask whether `containerId` exists in the project the runtime key belongs to. */
export async function probeLearningContainer(
  client: Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot">,
  containerId: string,
  timeoutMs = 5_000,
): Promise<ContainerProbe> {
  try {
    await client.getLearnedSkillsSnapshot({
      containerId,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "present";
  } catch (error) {
    return classifyProbeError(error);
  }
}

/** The organization and project a runtime key belongs to, by slug. */
export type KeyProject = { organizationSlug: string; projectSlug: string };

/**
 * Which project a runtime key belongs to, read from the Learning link Intelligence returns for it.
 *
 * The key cannot name its own project directly. The Inspector projection it can read carries a link
 * to the project's Learning page, `/o/<organization>/<project>/learning`, and that is enough for a
 * helper holding a person's login to refuse to create a container in some other project. Anything
 * unreadable is `undefined`, and callers treat that as "cannot prove it".
 */
export async function keyProject(
  client: Pick<CopilotKitIntelligence, "getInspectorLearning">,
  timeoutMs = 10_000,
): Promise<KeyProject | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The Inspector read takes no signal, so the deadline races it.
    const snapshot = await Promise.race([
      client.getInspectorLearning({}),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Inspector read timed out")),
          timeoutMs,
        );
      }),
    ]);
    const [o, organizationSlug, projectSlug, learning] = new URL(
      snapshot.links.learning,
    ).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (
      o !== "o" ||
      learning !== "learning" ||
      !organizationSlug ||
      !projectSlug
    )
      return undefined;
    return { organizationSlug, projectSlug };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A runtime key's project by slug and by name: everything the key can say about where it lives. */
export type KeyIdentity = KeyProject & {
  organizationName: string;
  projectName: string;
};

/**
 * The key's project slugs (see `keyProject`) and the organization and project names its Inspector
 * metadata carries. The names are what a CopilotKit CLI login can be compared on: the CLI reports
 * its organization by name and Clerk ID, never by slug. Anything unreadable is `undefined`.
 */
export async function keyIdentity(
  client: Pick<
    CopilotKitIntelligence,
    "getInspectorLearning" | "getInspectorMetadata"
  >,
  timeoutMs = 10_000,
): Promise<KeyIdentity | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [slugs, metadata] = await Promise.all([
      keyProject(client, timeoutMs),
      Promise.race([
        client.getInspectorMetadata(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Inspector metadata timed out")),
            timeoutMs,
          );
        }),
      ]),
    ]);
    const identity = metadata?.identity;
    if (!slugs || !identity?.organizationName || !identity.projectName)
      return undefined;
    return {
      ...slugs,
      organizationName: identity.organizationName,
      projectName: identity.projectName,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
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

/** What creating the container with a credential that can did. `skipped`: nothing here could. */
export type ContainerCreation = "present" | "created" | "skipped";

export type LearningAutoAssign = {
  /** Check now, unless a check is already running, and return what it found. Never throws. */
  check(): Promise<LearningAutoAssignState>;
  /**
   * Admin's "Create it now": try the configured credential again, whatever earlier attempts found,
   * then check. Never throws; a failure comes back as the state's `createError`.
   */
  createNow(): Promise<LearningAutoAssignState>;
  /** Start a check in the background if none ran within the last `minIntervalMs`. */
  kick(): void;
  /** The last answer, without asking. */
  state(): LearningAutoAssignState;
  /** Check at boot, then keep checking every `retryMs` until there is nothing left to do. */
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
 * - It creates the container only through `create`, with a credential that can (a service token on
 *   a local evaluation install, or a CopilotKit CLI login on this machine; see
 *   learning/ensure-container.ts), once per process unless Admin asks again. The runtime key cannot.
 *   With no such credential it says exactly what to run, once, in the log and on the Admin page.
 * - It is safe on many replicas: the write is a conditional insert, so the first one wins and the
 *   rest see a saved setting. Only the winner writes the audit row.
 * - It never blocks startup or a turn. Every failure is logged once per kind and tried again later.
 */
export function createLearningAutoAssign(options: {
  /** False when the operator switched this off or the environment names a container. */
  enabled: boolean;
  store: Pick<LearningSettingsStore, "saved" | "adoptDefault">;
  probe: (containerId: string) => Promise<ContainerProbe>;
  /** Create the container with a credential that can. Absent when this deployment holds none. */
  create?: () => Promise<ContainerCreation>;
  /** Exactly what an operator runs when the container is absent and nothing here created it. */
  instructions?: string;
  audit?: AuditStore;
  containerId?: string;
  retryMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
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
    `Run bun scripts/setup-learning.ts, or create a container with ID "${containerId}" in Intelligence; OpenBot assigns it within ${Math.round((options.retryMs ?? RETRY_MS) / 60_000)} minutes.`;
  /** Whether this process already tried `create`: once at boot, again only when Admin asks. */
  let createTried = false;
  let createError: string | undefined;

  /** Create it with the configured credential, once. True when it is there now. */
  const tryCreate = async (): Promise<boolean> => {
    if (!options.create || createTried) return false;
    createTried = true;
    try {
      const result = await options.create();
      createError = undefined;
      if (result === "skipped") return false;
      log({
        type: "learning-auto-assign",
        outcome: result === "created" ? "container_created" : "container_found",
        containerId,
        message:
          result === "created"
            ? `Created the "${containerId}" Learning container with the configured credential.`
            : `The "${containerId}" Learning container is there now.`,
      });
      return true;
    } catch (error) {
      createError =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "The container could not be created.";
      once("create_failed", { message: createError });
      return false;
    }
  };

  const absent = (): LearningAutoAssignState => ({
    state: "absent",
    containerId,
    instructions,
    canCreate: Boolean(options.create),
    ...(createError ? { createError } : {}),
  });

  const run = async (): Promise<LearningAutoAssignState> => {
    if (!options.enabled) return { state: "off" };
    if (await options.store.saved()) return { state: "saved" };
    let found = await options.probe(containerId);
    if (found === "absent" && (await tryCreate()))
      found = await options.probe(containerId);
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
    if (found === "unavailable") {
      once("unavailable", {
        message:
          "Intelligence could not be asked about the Learning container. OpenBot tries again.",
      });
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
      void check();
      timer = setInterval(() => void check(), options.retryMs ?? RETRY_MS);
      // Never keep the process alive for this alone.
      timer.unref?.();
    },
    stop: stopTimer,
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
