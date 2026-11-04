import {
  isLearningContainerId,
  type LearningSettings,
  type LearningTarget,
} from "@openbot/shared/learning";
import type { LearningChanges } from "./changes";
import {
  type AgentAssignments,
  type LearningIntelligence,
  LearningVersionConflictError,
} from "./intelligence";
import { currentEdition } from "../edition";

export type LearningSettingsStore = {
  read(): Promise<LearningSettings>;
  /**
   * The settings and the version they are, from this instance's copy: what a thread's container is decided from, so
   * the decision can be written with the version it came from (`bindThread`'s `assignmentsVersion`).
   */
  snapshot(): Promise<{ settings: LearningSettings; version: number }>;
  write(settings: LearningSettings): Promise<LearningSettings>;
  /** Whether an administrator has saved settings, including a saved off. */
  saved(): Promise<boolean>;
  /**
   * Save `target` as the default only while nothing is saved, and say whether this call saved it.
   *
   * One conditional insert, so replicas racing at boot cannot overwrite each other or an
   * administrator who saved between the check and the write: the first row wins and every later
   * call returns false.
   */
  adoptDefault(target: LearningTarget): Promise<boolean>;
  /**
   * Give a person's thread its container, first write wins: the answer is the winner's, null included. With
   * `assignmentsVersion`, refused (LearningAssignmentsChangedError) when that is no longer the saved version and this
   * would create the assignment, so a decision made from a stale copy is never written.
   */
  bindThread(input: {
    userId: string;
    threadId: string;
    agentId: string;
    containerId: string | null;
    assignmentsVersion?: number;
  }): Promise<string | null>;
  /** The container this instance already knows a thread was given (null included), or undefined when it does not. */
  boundThread(userId: string, threadId: string): string | null | undefined;
  /** Read the settings from Intelligence now, whatever this instance holds. */
  refresh(): Promise<void>;
  /** Read the settings, then keep them fresh from `changes` and a timer. Resolves once the first read is done. */
  start(changes?: LearningChanges): Promise<void>;
  stop(): void;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function target(value: unknown): value is LearningTarget | null {
  if (value === null) return true;
  return (
    object(value) &&
    isLearningContainerId(value.containerId) &&
    (value.revision === undefined ||
      (typeof value.revision === "string" &&
        value.revision.length > 0 &&
        value.revision.length <= 256 &&
        value.revision.trim() === value.revision &&
        ![...value.revision].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ))) &&
    Object.keys(value).every(
      (key) => key === "containerId" || key === "revision",
    )
  );
}

export function parseLearningSettings(
  input: unknown,
): { ok: true; settings: LearningSettings } | { ok: false; error: string } {
  if (
    !object(input) ||
    typeof input.enabled !== "boolean" ||
    !target(input.defaultTarget) ||
    !object(input.agents) ||
    Object.keys(input).some(
      (key) => !["enabled", "defaultTarget", "agents"].includes(key),
    )
  ) {
    return {
      ok: false,
      error:
        "Provide enabled, a default container (or null), and per-Bot mappings. Container IDs use 1–64 lowercase letters, numbers, and single hyphens.",
    };
  }
  if (
    Object.entries(input.agents).some(
      ([id, value]) => id.length === 0 || id.length > 128 || !target(value),
    ) ||
    Object.keys(input.agents).length > 1000
  ) {
    return {
      ok: false,
      error:
        "Each Bot mapping must name a valid container or be null to exclude the Bot.",
    };
  }
  return { ok: true, settings: structuredClone(input) as LearningSettings };
}

/** A short timer: an announcement can be lost, and this bounds how long a missed one goes unseen. */
const REFRESH_INTERVAL_MS = 15_000;
/** The thread assignments one instance remembers. They never change once written, so any held one is right. */
const THREADS_HELD = 10_000;
/** A save that keeps meeting newer versions gives up after this many tries. */
const SAVE_ATTEMPTS = 4;

/**
 * The Learning settings, held in memory on this instance and kept fresh from Intelligence.
 *
 * They are read on every run, so reading Intelligence on each would put a round trip under every turn. They were read
 * from the database each time so a change took effect across replicas at once; the copy here keeps that as close as a
 * copy can, and closes the one gap that matters:
 *
 * - The instance that saves updates its copy from Intelligence's answer before the save returns, so it reads its own
 *   change at once.
 * - Every other instance hears of it from Intelligence's change feed (`learning_changes`) and reads again; it also
 *   reads again whenever its subscription joins (the first time and after every reconnect) and every 15 seconds,
 *   because an announcement can be lost.
 * - The one durable decision made from the settings, which container a thread's first run joins, is written with the
 *   version it was decided from. An instance whose copy is stale is refused (LearningAssignmentsChangedError), reads
 *   again and decides again (learning/runtime.ts `containerForThread`), so no thread is ever bound from old settings.
 *
 * Without `intelligence` the settings live in this process only, for tests of what reads them.
 */
export function createLearningSettingsStore(
  intelligence?: LearningIntelligence,
  configured?: LearningTarget,
  options: { refreshIntervalMs?: number } = {},
): LearningSettingsStore {
  const fallback: LearningSettings = {
    enabled: true,
    defaultTarget: configured ?? null,
    agents: {},
  };
  let current = structuredClone(fallback);
  let written = false;
  const bindings = new Map<string, string | null>();
  const threadKey = (userId: string, threadId: string) =>
    JSON.stringify([userId, threadId]);
  const remember = (key: string, containerId: string | null) => {
    bindings.delete(key);
    bindings.set(key, containerId);
    if (bindings.size > THREADS_HELD) {
      const oldest = bindings.keys().next().value;
      if (oldest !== undefined) bindings.delete(oldest);
    }
  };

  /** What Intelligence last said, or undefined before the first read. */
  let held: AgentAssignments | undefined;
  let reading: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => void) | undefined;

  /** Keep `next` unless this instance already holds a newer version (a save's answer, say). */
  const apply = (next: AgentAssignments) => {
    if (held && held.version > next.version) return;
    const parsed = parseLearningSettings(next.settings);
    if (!parsed.ok) throw new Error("Stored learning settings are invalid.");
    held = { ...next, settings: parsed.settings };
  };
  /** Nothing saved reads as the deployment's own default: on, with the container the environment names, if any. */
  const effective = (): LearningSettings =>
    !held || held.savedAt === null ? fallback : held.settings;

  const refresh = (): Promise<void> => {
    if (!intelligence) return Promise.resolve();
    reading ??= intelligence
      .agentAssignments()
      .then(apply)
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  const loaded = async () => {
    if (!held) await refresh();
  };
  const quietRefresh = (reason: string) => {
    refresh().catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "learning-settings-refresh-failed",
          reason,
          note: "Still using the settings this instance last read.",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  };

  return {
    async saved() {
      if (!intelligence) return written;
      await refresh();
      return held?.savedAt != null;
    },
    async adoptDefault(target) {
      const settings: LearningSettings = {
        enabled: true,
        defaultTarget: { containerId: target.containerId },
        agents: {},
      };
      const parsed = parseLearningSettings(settings);
      if (!parsed.ok) throw new TypeError(parsed.error);
      if (!intelligence) {
        if (written) return false;
        current = structuredClone(parsed.settings);
        written = true;
        return true;
      }
      try {
        // Version 0: only while nothing is saved, so replicas racing at boot cannot overwrite each other or an
        // administrator who saved between the check and the write. The first one wins; every other is refused.
        apply(await intelligence.saveAgentAssignments(parsed.settings, 0));
        return true;
      } catch (error) {
        if (!(error instanceof LearningVersionConflictError)) throw error;
        await refresh();
        return false;
      }
    },
    async read() {
      if (intelligence) await loaded();
      const settings = structuredClone(intelligence ? effective() : current);
      // The pause lives on an Admin screen the personal edition does not have, so it never applies.
      return currentEdition() === "personal"
        ? { ...settings, enabled: true }
        : settings;
    },
    async snapshot() {
      if (!intelligence)
        return { settings: structuredClone(current), version: 0 };
      await loaded();
      return {
        settings: structuredClone(effective()),
        version: held?.version ?? 0,
      };
    },
    async write(settings) {
      const parsed = parseLearningSettings(settings);
      if (!parsed.ok) throw new TypeError(parsed.error);
      if (!intelligence) {
        current = structuredClone(parsed.settings);
        written = true;
        return structuredClone(parsed.settings);
      }
      // An administrator's save replaces what is there, as it always did: a newer version met on the way is read and
      // saved over, not reported.
      for (let attempt = 1; ; attempt++) {
        await loaded();
        try {
          apply(
            await intelligence.saveAgentAssignments(
              parsed.settings,
              held?.version ?? 0,
            ),
          );
          return structuredClone(parsed.settings);
        } catch (error) {
          if (
            !(error instanceof LearningVersionConflictError) ||
            attempt >= SAVE_ATTEMPTS
          )
            throw error;
          await refresh();
        }
      }
    },
    async bindThread(input) {
      const key = threadKey(input.userId, input.threadId);
      if (!intelligence) {
        if (!bindings.has(key)) bindings.set(key, input.containerId);
        return bindings.get(key) ?? null;
      }
      const assigned = await intelligence.assignThread({
        threadId: input.threadId,
        appUserId: input.userId,
        agentId: input.agentId,
        learningContainerId: input.containerId,
        ...(input.assignmentsVersion === undefined
          ? {}
          : { assignmentsVersion: input.assignmentsVersion }),
      });
      remember(key, assigned.learningContainerId);
      return assigned.learningContainerId;
    },
    boundThread(userId, threadId) {
      if (!intelligence) return undefined;
      const key = threadKey(userId, threadId);
      return bindings.has(key) ? (bindings.get(key) ?? null) : undefined;
    },
    refresh,
    async start(changes) {
      if (!intelligence) return;
      unlisten = changes?.listen({
        onChange: (change) => {
          if (change.entity !== "agent_assignments") return;
          if (held && held.version >= change.version) return;
          quietRefresh("announced");
        },
        onJoined: () => quietRefresh("joined"),
      });
      await refresh();
      timer = setInterval(
        () => quietRefresh("timer"),
        options.refreshIntervalMs ?? REFRESH_INTERVAL_MS,
      );
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      unlisten?.();
      unlisten = undefined;
    },
  };
}
