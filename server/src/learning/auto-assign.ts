import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import {
  AUTOMATIC_LEARNING_CONTAINER_ID,
  type LearningAutoAssignState,
  type LearningTarget,
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
import type {
  ConfiguredLearningContainer,
  LearningSettingsStore,
} from "./settings";

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

/** The runtime client's catch-alls: a refusal it has no code for, which the read below can name. */
const UNNAMED_REFUSALS = new Set([
  "UNSUPPORTED_SERVER",
  "AUTHORIZATION_FAILED",
]);

/**
 * Ask whether `containerId` exists in the project the runtime key belongs to.
 *
 * The published-Skills read answers it on every Intelligence. When that read fails with a code the
 * runtime client does not know (it reports any such refusal as `UNSUPPORTED_SERVER`, or a 403 as
 * `AUTHORIZATION_FAILED`), the container itself is read on the same key, whose refusal carries
 * Intelligence's own code: Learning switched off, a missing container, or Learning not licensed.
 */
export async function probeLearningContainer(
  client: Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot"> & {
    experimental?: {
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
    await client.getLearnedSkillsSnapshot({
      containerId,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return "present";
  } catch (error) {
    const found = classifyProbeError(error);
    const { code } = requestFailure(error);
    if (
      found !== "unavailable" ||
      !client.experimental ||
      !code ||
      !UNNAMED_REFUSALS.has(code)
    )
      return found;
    try {
      await client.experimental.learning.getLearningContainer({
        containerId,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return "present";
    } catch (named) {
      return classifyLearningRouteError(named);
    }
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
 *   container named in the environment both mean there is nothing to do, once Intelligence says it
 *   has the container named. One it does not have is a stale name, not a choice: it is logged,
 *   forgotten, and assignment goes ahead as though nothing was named (see `configured`). A saved
 *   default container it does not have is logged and set aside the same way, but stays saved, for
 *   the Intelligence it was chosen on: what assignment finds is used in its place, here only.
 * - It creates the container only through `create`, with a credential that can (the runtime key on
 *   an Intelligence that allows it, a service token on a local evaluation install, or a CopilotKit
 *   CLI login on this machine; see learning/ensure-container.ts), once per process unless Admin asks
 *   again. With none of them it says exactly what to run, once, in the log and on the Admin page.
 * - It is safe on many replicas: the write is a conditional insert, so the first one wins and the
 *   rest see a saved setting. Only the winner writes the audit row.
 * - It never blocks startup or a turn. Every failure is logged once per kind and tried again later.
 * - It waits out an Intelligence that is still starting at boot: while the boot check finds it
 *   unavailable it asks again, quietly, and says it could not be asked only if that is still so
 *   when the startup window closes.
 */
export function createLearningAutoAssign(options: {
  /** False when the operator switched this off (`OPENBOT_LEARNING_AUTO_ASSIGN`). */
  enabled: boolean;
  /**
   * The container the environment names, checked first. There, and there is nothing to assign.
   * Absent on this Intelligence, and it is forgotten and assignment runs as though it was never
   * named. The Intelligence a server talks to is fixed for its life, and pointing it at another one
   * restarts it, so a check per process is a check per Intelligence.
   */
  configured?: ConfiguredLearningContainer;
  store: Pick<LearningSettingsStore, "saved" | "adoptDefault"> &
    Partial<
      Pick<LearningSettingsStore, "savedDefault" | "setAside" | "restore">
    >;
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
  /** How long the boot check gives a starting Intelligence, and the clock it waits on. */
  startup?: StartupClock;
}): LearningAutoAssign {
  const containerId = options.containerId ?? AUTOMATIC_LEARNING_CONTAINER_ID;
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const log = options.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  /** Whether there is anything to check: assignment, or a container the environment names. */
  const active = () =>
    options.enabled || options.configured?.target() !== undefined;
  let current: LearningAutoAssignState = active()
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
    `Run bun scripts/setup-learning.ts, or create a container with ID "${containerId}" in the backend dashboard; OpenBot assigns it within ${Math.round((options.retryMs ?? RETRY_MS) / 60_000)} minutes.`;
  /** Whether this process already tried `create`: once at boot, again only when Admin asks. */
  let createTried = false;
  let createError: string | undefined;
  /**
   * Whether the last attempt found nothing here that could create it (an Intelligence that does not
   * let the runtime key, and no other credential). Admin then shows the steps, not a button.
   */
  let createSkipped = false;

  /**
   * Create it with the configured credential, once. True when it is there now. `unavailable` when
   * Intelligence could not answer just then (a 5xx, nothing answering), which is not this
   * credential's one try: the next check tries again.
   */
  const tryCreate = async (): Promise<boolean | "unavailable"> => {
    if (!options.create || createTried) return false;
    createTried = true;
    try {
      const result = await options.create();
      createError = undefined;
      createSkipped = result === "skipped";
      if (createSkipped) return false;
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
    canCreate: Boolean(options.create) && !createSkipped,
    ...(createError ? { createError } : {}),
  });

  /**
   * Whether the environment's container is there. "stands": it is, or Intelligence answered without
   * saying it is not (Learning off, or not licensed), so the choice stands as it always did.
   * "forgotten": Intelligence says it has no such container, so it no longer names the default.
   */
  const checkConfigured = async (
    target: LearningTarget,
  ): Promise<"stands" | "forgotten" | "unavailable"> => {
    const found = await options.probe(target.containerId);
    if (found === "unavailable") return "unavailable";
    if (found !== "absent") return "stands";
    options.configured?.forget();
    once("configured_absent", {
      containerId: target.containerId,
      variable: "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID",
      message: `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID is "${target.containerId}", but this Intelligence has no Learning container with that ID, so OpenBot ignores it${options.enabled ? ` and assigns "${containerId}" instead` : ""}. Remove it from the environment, or set it to a container this Intelligence has.`,
    });
    return "forgotten";
  };

  /**
   * Whether the saved default container is there. "stands": it is, none is saved, or Intelligence
   * answered without saying it is not. "set_aside": Intelligence says it has no such container. The
   * saved choice is kept (switching back to the Intelligence it was made on brings it back), but it
   * no longer names the default here (`LearningSettingsStore.setAside`).
   */
  const checkSaved = async (): Promise<
    | { checked: "stands" }
    | { checked: "unavailable" }
    | { checked: "set_aside"; containerId: string }
  > => {
    const saved = await options.store.savedDefault?.();
    if (!saved || !options.store.setAside) return { checked: "stands" };
    const found = await options.probe(saved.containerId);
    if (found === "unavailable") return { checked: "unavailable" };
    if (found !== "absent") {
      options.store.restore?.();
      return { checked: "stands" };
    }
    options.store.setAside(saved.containerId);
    once("saved_absent", {
      containerId: saved.containerId,
      message: `The saved default Learning container is "${saved.containerId}", but this Intelligence has no Learning container with that ID, so OpenBot ignores it here${options.enabled ? ` and uses "${containerId}" instead` : ""}. The saved choice is kept, for an Intelligence that has it. Saving another default container replaces it.`,
    });
    return { checked: "set_aside", containerId: saved.containerId };
  };

  const run = async (): Promise<LearningAutoAssignState> => {
    unsaid = false;
    if (!active()) return { state: "off" };
    /** The saved default this Intelligence does not have: what is found is used in its place, not saved. */
    let setAside: string | undefined;
    if (await options.store.saved()) {
      const saved = await checkSaved();
      if (saved.checked === "unavailable") {
        if (starting) unsaid = true;
        else sayUnavailable();
        return { state: "unavailable" };
      }
      if (saved.checked === "stands") return { state: "saved" };
      if (!options.enabled) return { state: "off" };
      setAside = saved.containerId;
    }
    const configured = setAside ? undefined : options.configured?.target();
    if (configured) {
      const checked = await checkConfigured(configured);
      if (checked === "unavailable") {
        if (starting) unsaid = true;
        else sayUnavailable();
        return { state: "unavailable" };
      }
      if (checked === "stands" || !options.enabled) return { state: "off" };
    }
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
    if (setAside) {
      options.store.setAside?.(setAside, { containerId });
      log({
        type: "learning-auto-assign",
        outcome: "assigned",
        containerId,
        message: `Uses the "${containerId}" Learning container on this Intelligence in place of the saved "${setAside}", which it does not have. The saved choice is kept.`,
      });
      return { state: "assigned", containerId };
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
      if (!active()) return;
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
      // With a default too, until the check settles: that default may be the environment's
      // container, not yet confirmed on this Intelligence. Once settled, `kick` does nothing.
      if (settings.enabled) autoAssign.kick();
      return settings;
    },
  };
}
