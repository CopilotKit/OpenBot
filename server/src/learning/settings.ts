import { eq } from "drizzle-orm";
import {
  isLearningContainerId,
  type LearningSettings,
  type LearningTarget,
} from "../../../shared/learning";
import type { Database } from "../db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../db/schema/learning";

export type LearningSettingsStore = {
  read(): Promise<LearningSettings>;
  write(settings: LearningSettings): Promise<LearningSettings>;
  bindThread(input: {
    userId: string;
    threadId: string;
    agentId: string;
    containerId: string | null;
  }): Promise<string | null>;
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

/** Reads the database each time so changes take effect across replicas without a stale cache. */
export function createLearningSettingsStore(
  database?: Database,
  configured?: LearningTarget,
): LearningSettingsStore {
  const fallback: LearningSettings = {
    enabled: Boolean(configured),
    defaultTarget: configured ?? null,
    agents: {},
  };
  let current = structuredClone(fallback);
  const bindings = new Map<string, string | null>();
  return {
    async read() {
      if (!database) return structuredClone(current);
      const [row] = await database
        .select()
        .from(learningSettings)
        .where(eq(learningSettings.id, "current"))
        .limit(1);
      if (!row) return structuredClone(fallback);
      const parsed = parseLearningSettings(row.settings);
      if (!parsed.ok) throw new Error("Stored learning settings are invalid.");
      return parsed.settings;
    },
    async write(settings) {
      const parsed = parseLearningSettings(settings);
      if (!parsed.ok) throw new TypeError(parsed.error);
      if (database) {
        await database
          .insert(learningSettings)
          .values({ id: "current", settings: parsed.settings })
          .onConflictDoUpdate({
            target: learningSettings.id,
            set: { settings: parsed.settings, updatedAt: new Date() },
          });
      } else current = structuredClone(parsed.settings);
      return structuredClone(parsed.settings);
    },
    async bindThread(input) {
      if (database) {
        // Conflict updates no assignment. RETURNING observes the winner atomically, including null.
        const [row] = await database
          .insert(learningThreadBindings)
          .values(input)
          .onConflictDoUpdate({
            target: [
              learningThreadBindings.userId,
              learningThreadBindings.threadId,
            ],
            set: { threadId: input.threadId },
          })
          .returning({ containerId: learningThreadBindings.containerId });
        if (!row) throw new Error("Learning thread assignment was not saved.");
        return row.containerId;
      }
      const key = JSON.stringify([input.userId, input.threadId]);
      if (!bindings.has(key)) bindings.set(key, input.containerId);
      return bindings.get(key) ?? null;
    },
  };
}
