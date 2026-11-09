import {
  isLearningContainerId,
  isLearningPersonalReview,
  type LearningSettings,
  type LearningTarget,
} from "@openbot/shared/learning";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  learningSettings,
  learningThreadBindings,
} from "../db/schema/learning";
import { currentEdition } from "../edition";

export type LearningSettingsStore = {
  read(): Promise<LearningSettings>;
  write(settings: LearningSettings): Promise<LearningSettings>;
  /**
   * Save only `autoApprove`, leaving every other stored key (a stored off included) as it is.
   * With nothing saved yet it saves the defaults (a configured default container included)
   * alongside it.
   */
  setAutoApprove(autoApprove: boolean): Promise<void>;
  /**
   * Whether an administrator has saved settings, including a saved off. In the personal edition,
   * which has no Admin screen to choose a default container, only a saved default container counts.
   */
  saved(): Promise<boolean>;
  /**
   * Save `target` as the default only while nothing is saved, and say whether this call saved it.
   *
   * One conditional write, so replicas racing at boot cannot overwrite each other or an
   * administrator who saved between the check and the write: the first one wins and every later
   * call returns false. In the personal edition a saved row without a default container (one that
   * only holds automatic approval, say) still takes the target, keeping its other keys.
   */
  adoptDefault(target: LearningTarget): Promise<boolean>;
  /** The default container as saved, whether or not it is set aside here. Null when none is saved. */
  savedDefault(): Promise<LearningTarget | null>;
  /**
   * The saved default container is not on the Intelligence this server talks to
   * (learning/auto-assign.ts). It stays saved, for the Intelligence it was chosen on, but reads here
   * as `standIn`, or as no container until assignment finds one. Writing back what was read keeps
   * the saved choice beneath it; writing another container replaces it, as any save does.
   */
  setAside(containerId: string, standIn?: LearningTarget): void;
  /** The set-aside container is there after all (made since): it reads as saved again. */
  restore(): void;
  /** Whether `containerId` is the saved default set aside on this Intelligence. */
  isSetAside(containerId: string): boolean;
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
      (key) =>
        ![
          "enabled",
          "defaultTarget",
          "agents",
          "personalReview",
          "autoApprove",
        ].includes(key),
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
  if (
    (input.personalReview !== undefined &&
      !isLearningPersonalReview(input.personalReview)) ||
    (input.autoApprove !== undefined && typeof input.autoApprove !== "boolean")
  ) {
    return {
      ok: false,
      error:
        "Choose who reviews personal Learning (admins or people), and turn automatic approval on or off.",
    };
  }
  return { ok: true, settings: structuredClone(input) as LearningSettings };
}

/**
 * A saved row as this build reads it: the keys it knows, and nothing it does not.
 *
 * A newer build may save a key this one has never heard of, and builds do go back (an update that is
 * rolled back). Read strictly, one such key ("autoApprove") made the whole row invalid, and every chat
 * run failed with "Failed to resolve Learning Container". What is written is still checked strictly
 * (`parseLearningSettings`); only what is read back is forgiving.
 */
export function parseStoredLearningSettings(
  input: unknown,
): ReturnType<typeof parseLearningSettings> {
  const known = (value: unknown, keys: readonly string[]) =>
    object(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => keys.includes(key)),
        )
      : value;
  const targetKeys = ["containerId", "revision"] as const;
  if (!object(input)) return parseLearningSettings(input);
  const kept = known(input, [
    "enabled",
    "defaultTarget",
    "agents",
    "personalReview",
    "autoApprove",
  ]) as Record<string, unknown>;
  return parseLearningSettings({
    ...kept,
    defaultTarget: known(kept.defaultTarget, targetKeys),
    agents: object(kept.agents)
      ? Object.fromEntries(
          Object.entries(kept.agents).map(([id, value]) => [
            id,
            known(value, targetKeys),
          ]),
        )
      : kept.agents,
  });
}

/**
 * The Learning container the environment names (`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`), until a
 * check finds the Intelligence this server talks to has no such container.
 *
 * A name is only good on the Intelligence it was written for. One left in `.env` by a setup against
 * another Intelligence (hosted, say, before OpenBot Desktop pointed the same folder at its own) named
 * a container this one does not have, so every new thread was refused ("Failed to initialize
 * thread"), and naming one also stood automatic assignment aside. Forgotten, it is as though it was
 * never set: the default is unchosen and automatic assignment picks one (learning/auto-assign.ts).
 */
export type ConfiguredLearningContainer = {
  /** The configured container, or undefined once forgotten or when none was named. */
  target(): LearningTarget | undefined;
  /** This Intelligence does not have it: stop offering it as the default. */
  forget(): void;
  /** Whether `containerId` is the configured container this Intelligence was found not to have. */
  forgotten(containerId: string): boolean;
};

export function configuredLearningContainer(
  configured?: LearningTarget,
): ConfiguredLearningContainer {
  let current = configured;
  return {
    target: () => current,
    forget() {
      current = undefined;
    },
    forgotten: (containerId) =>
      configured !== undefined &&
      current === undefined &&
      configured.containerId === containerId,
  };
}

/** Reads the database each time so changes take effect across replicas without a stale cache. */
export function createLearningSettingsStore(
  database?: Database,
  configured?: LearningTarget | ConfiguredLearningContainer,
): LearningSettingsStore {
  const environment =
    configured !== undefined && "target" in configured
      ? configured
      : configuredLearningContainer(configured);
  /** Read each time, so a forgotten container stops being the default at once. */
  const fallback = (): LearningSettings => ({
    enabled: true,
    defaultTarget: structuredClone(environment.target()) ?? null,
    agents: {},
  });
  let current = fallback();
  let written = false;
  const bindings = new Map<string, string | null>();
  /** The saved default this Intelligence does not have, and what reads in its place. */
  let aside:
    | { containerId: string; standIn: LearningTarget | null }
    | undefined;
  /** As saved: what `write` keeps and `savedDefault` reports. */
  const saved = async (): Promise<LearningSettings> => {
    if (!database) return structuredClone(written ? current : fallback());
    const [row] = await database
      .select()
      .from(learningSettings)
      .where(eq(learningSettings.id, "current"))
      .limit(1);
    if (!row) return fallback();
    const parsed = parseStoredLearningSettings(row.settings);
    if (!parsed.ok) throw new Error("Stored learning settings are invalid.");
    return parsed.settings;
  };
  /** As read: a set-aside default replaced by its stand-in. */
  const stored = async (): Promise<LearningSettings> => {
    const settings = await saved();
    if (aside && settings.defaultTarget?.containerId === aside.containerId)
      return { ...settings, defaultTarget: structuredClone(aside.standIn) };
    return settings;
  };
  const sameTarget = (a: LearningTarget | null, b: LearningTarget | null) =>
    a?.containerId === b?.containerId && a?.revision === b?.revision;
  return {
    async savedDefault() {
      return (await saved()).defaultTarget;
    },
    setAside(containerId, standIn) {
      aside = {
        containerId,
        standIn: standIn
          ? { containerId: standIn.containerId }
          : aside?.containerId === containerId
            ? aside.standIn
            : null,
      };
    },
    restore() {
      aside = undefined;
    },
    isSetAside: (containerId) => aside?.containerId === containerId,
    async saved() {
      const personal = currentEdition() === "personal";
      if (!database)
        return written && (!personal || current.defaultTarget !== null);
      const [row] = await database
        .select({ settings: learningSettings.settings })
        .from(learningSettings)
        .where(eq(learningSettings.id, "current"))
        .limit(1);
      return (
        row !== undefined && (!personal || row.settings.defaultTarget !== null)
      );
    },
    async adoptDefault(target) {
      const settings: LearningSettings = {
        enabled: true,
        defaultTarget: { containerId: target.containerId },
        agents: {},
      };
      const parsed = parseLearningSettings(settings);
      if (!parsed.ok) throw new TypeError(parsed.error);
      // A saved row with no default container is an admin's choice in the team edition only.
      const personal = currentEdition() === "personal";
      if (!database) {
        if (!written) {
          current = structuredClone(parsed.settings);
          written = true;
          return true;
        }
        if (!personal || current.defaultTarget !== null) return false;
        current = { ...current, defaultTarget: parsed.settings.defaultTarget };
        return true;
      }
      const insert = database
        .insert(learningSettings)
        .values({ id: "current", settings: parsed.settings });
      const adopted = personal
        ? await insert
            .onConflictDoUpdate({
              target: learningSettings.id,
              set: {
                settings: sql`jsonb_set(${learningSettings.settings}, '{defaultTarget}', ${JSON.stringify(parsed.settings.defaultTarget)}::text::jsonb)`,
                updatedAt: new Date(),
              },
              setWhere: sql`${learningSettings.settings}->'defaultTarget' = 'null'::jsonb`,
            })
            .returning({ id: learningSettings.id })
        : await insert
            .onConflictDoNothing({ target: learningSettings.id })
            .returning({ id: learningSettings.id });
      return adopted.length > 0;
    },
    async read() {
      const settings = await stored();
      // The pause lives on an Admin screen the personal edition does not have, so it never applies.
      return currentEdition() === "personal"
        ? { ...settings, enabled: true }
        : settings;
    },
    async write(settings) {
      const parsed = parseLearningSettings(settings);
      if (!parsed.ok) throw new TypeError(parsed.error);
      /*
       * Saving what was read (Admin's whole page, or who approves Skills) carries the stand-in back.
       * That is not a new choice of container, so the one saved for another Intelligence stays.
       */
      let next = parsed.settings;
      if (aside && sameTarget(next.defaultTarget, aside.standIn)) {
        const before = await saved().then(
          (settings) => settings.defaultTarget,
          () => null,
        );
        if (before?.containerId === aside.containerId)
          next = { ...next, defaultTarget: before };
      }
      if (database) {
        await database
          .insert(learningSettings)
          .values({ id: "current", settings: next })
          .onConflictDoUpdate({
            target: learningSettings.id,
            set: { settings: next, updatedAt: new Date() },
          });
      } else {
        current = structuredClone(next);
        written = true;
      }
      return structuredClone(parsed.settings);
    },
    async setAutoApprove(autoApprove) {
      if (typeof autoApprove !== "boolean")
        throw new TypeError("Automatic approval is on or off.");
      if (!database) {
        current = { ...(written ? current : fallback()), autoApprove };
        written = true;
        return;
      }
      const settings: LearningSettings = { ...fallback(), autoApprove };
      await database
        .insert(learningSettings)
        .values({ id: "current", settings })
        .onConflictDoUpdate({
          target: learningSettings.id,
          set: {
            settings: sql`jsonb_set(${learningSettings.settings}, '{autoApprove}', to_jsonb(${autoApprove}::boolean))`,
            updatedAt: new Date(),
          },
        });
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
