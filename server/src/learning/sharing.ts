import type { LearningSharingMode } from "@openbot/shared/learning";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  learningOpenSkills,
  learningSkillSharing,
} from "../db/schema/learning";
import { personalLearningContainerId } from "./personal-space";

/**
 * One person's Skills that every Bot in the deployment may use: all of them (`open`), or the ones they opened by name
 * (`choose`). A person whose choice is `closed`, or `choose` with nothing opened, has no entry.
 *
 * Which of them the person approved only for themselves (and so must not reach other people's Bots) is not part of it:
 * a run reads that fresh (learning/runtime.ts `PersonalSkillSources.withheld`), because a replica that did not handle an
 * approval would otherwise keep sharing the Skill until its index expired.
 */
export type OpenSkillSource = {
  userId: string;
  containerId: string;
  skills: "all" | ReadonlySet<string>;
};

/** The sharing choice a person made for the Skills in their own Learning space. */
export function createLearningSharingStore(database: Database) {
  return {
    /**
     * Their choice (`closed` when they never made one) and every Skill they opened under `choose`, both from one
     * snapshot, so a change saved between the two reads cannot produce a pair that never existed.
     */
    async read(
      userId: string,
    ): Promise<{ mode: LearningSharingMode; openSkills: string[] }> {
      return database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({ mode: learningSkillSharing.mode })
            .from(learningSkillSharing)
            .where(eq(learningSkillSharing.userId, userId))
            .limit(1);
          const opened = await transaction
            .select({ name: learningOpenSkills.skillName })
            .from(learningOpenSkills)
            .where(eq(learningOpenSkills.userId, userId))
            .orderBy(learningOpenSkills.skillName);
          return {
            mode: row?.mode ?? "closed",
            openSkills: opened.map((skill) => skill.name),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    /** Saves the choice and says what it was before. Two saves at once are taken in turn, so each `from` is true. */
    async setMode(
      userId: string,
      mode: LearningSharingMode,
    ): Promise<{ from: LearningSharingMode; to: LearningSharingMode }> {
      return database.transaction(async (transaction) => {
        // Lock the person's row (or, with none yet, take the insert's turn) before reading what it holds.
        await transaction
          .insert(learningSkillSharing)
          .values({ userId })
          .onConflictDoNothing();
        const [row] = await transaction
          .select({ mode: learningSkillSharing.mode })
          .from(learningSkillSharing)
          .where(eq(learningSkillSharing.userId, userId))
          .for("update");
        await transaction
          .update(learningSkillSharing)
          .set({ mode, updatedAt: new Date() })
          .where(eq(learningSkillSharing.userId, userId));
        return { from: row?.mode ?? "closed", to: mode };
      });
    },

    /** Opens or closes one Skill by name. True when that changed anything. */
    async setSkillOpen(
      userId: string,
      skillName: string,
      open: boolean,
    ): Promise<boolean> {
      if (open) {
        const inserted = await database
          .insert(learningOpenSkills)
          .values({ userId, skillName })
          .onConflictDoNothing()
          .returning({ name: learningOpenSkills.skillName });
        return inserted.length > 0;
      }
      const deleted = await database
        .delete(learningOpenSkills)
        .where(
          and(
            eq(learningOpenSkills.userId, userId),
            eq(learningOpenSkills.skillName, skillName),
          ),
        )
        .returning({ name: learningOpenSkills.skillName });
      return deleted.length > 0;
    },

    /** Everyone who opened something, and what. Read by the open-Skill index, never per run. */
    async openSources(): Promise<OpenSkillSource[]> {
      const sharing = await database
        .select({
          userId: learningSkillSharing.userId,
          mode: learningSkillSharing.mode,
        })
        .from(learningSkillSharing)
        .where(ne(learningSkillSharing.mode, "closed"));
      const choosing = sharing
        .filter((row) => row.mode === "choose")
        .map((row) => row.userId);
      const chosen =
        choosing.length === 0
          ? []
          : await database
              .select({
                userId: learningOpenSkills.userId,
                name: learningOpenSkills.skillName,
              })
              .from(learningOpenSkills)
              .where(inArray(learningOpenSkills.userId, choosing));
      const byPerson = new Map<string, Set<string>>();
      for (const row of chosen) {
        let names = byPerson.get(row.userId);
        if (!names) {
          names = new Set();
          byPerson.set(row.userId, names);
        }
        names.add(row.name);
      }
      return sharing.flatMap((row): OpenSkillSource[] => {
        const containerId = personalLearningContainerId(row.userId);
        if (row.mode === "open") {
          return [
            {
              userId: row.userId,
              containerId,
              skills: "all",
            },
          ];
        }
        const names = byPerson.get(row.userId);
        return names && names.size > 0
          ? [
              {
                userId: row.userId,
                containerId,
                skills: names,
              },
            ]
          : [];
      });
    },
  };
}
export type LearningSharingStore = ReturnType<
  typeof createLearningSharingStore
>;

/** How long a replica keeps the open-Skill index before reading it again. A change made on this replica is seen at once. */
const INDEX_TTL_MS = 30_000;

/**
 * What every person has opened, kept in memory so a run never asks the database (let alone each person's space) who
 * shares what. Read again after `ttlMs`, and at once after `invalidate()`, which the Settings routes call on every
 * change; another replica sees that change within `ttlMs`. A failed read keeps the last index, or none.
 */
export function createOpenSkillIndex(deps: {
  read: () => Promise<OpenSkillSource[]>;
  ttlMs?: number;
  now?: () => number;
}) {
  const ttlMs = deps.ttlMs ?? INDEX_TTL_MS;
  const now = deps.now ?? Date.now;
  let current: { sources: OpenSkillSource[]; readAt: number } | undefined;
  /**
   * Bumped by `invalidate`. A read that began before a change is neither shared with callers that come after it nor
   * kept as the index, so neither sees the answer from before the change.
   */
  let generation = 0;
  /** The read in flight for the current generation, which every caller in that generation shares. */
  let reading:
    | { generation: number; sources: Promise<OpenSkillSource[]> }
    | undefined;

  const refresh = () => {
    if (reading?.generation === generation) return reading.sources;
    const started = generation;
    const read: NonNullable<typeof reading> = {
      generation: started,
      sources: deps
        .read()
        .then((sources) => {
          if (started === generation) current = { sources, readAt: now() };
          return sources;
        })
        .finally(() => {
          // A read from an older generation must not clear the one that replaced it.
          if (reading === read) reading = undefined;
        }),
    };
    reading = read;
    return read.sources;
  };

  return {
    async sources(): Promise<OpenSkillSource[]> {
      if (current && now() - current.readAt < ttlMs) return current.sources;
      try {
        return await refresh();
      } catch (error) {
        if (current) return current.sources;
        throw error;
      }
    },
    invalidate() {
      generation++;
      current = undefined;
    },
  };
}
export type OpenSkillIndex = ReturnType<typeof createOpenSkillIndex>;
