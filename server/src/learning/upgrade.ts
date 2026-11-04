/**
 * Moving an existing deployment's Learning settings and pointers into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds them in six tables: `learning_settings` (the Admin settings),
 * `learning_thread_bindings` (each thread's container), `learning_person_spaces` (the spaces seen to exist),
 * `learning_skill_sharing` and `learning_open_skills` (each person's sharing choice), and
 * `recorder_trajectory_bindings` (whose each Recorder trajectory is). This copies every row into Intelligence's Learning
 * assignments (learning/intelligence.ts), checks that Intelligence holds each, and only then records the copy as done,
 * so it never runs again: the tables stay in place for one release and nothing writes them.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. Every write is one Intelligence keeps the first
 * of (a thread's container, a trajectory's owner, a space seen to exist) or makes only while nothing is saved (the
 * settings, with If-None-Match: *), and each carries an idempotency key made from the row, so replicas copying at once
 * send the same requests and get the same answers.
 *
 * WHAT INTELLIGENCE ALREADY HOLDS WINS. Settings are copied only when Intelligence has none saved. A sharing choice is
 * copied only onto a space whose choice is still the default (closed, nothing opened). A thread's container and a
 * trajectory's owner are first-write-wins there, so an earlier answer stands; a trajectory Intelligence already gives
 * to another person (its Runtime join bound it first) is said in the log, because that person is the one Intelligence
 * lets record into it either way.
 *
 * LOUD ON A MISMATCH. A row Intelligence refuses, or one missing after the copy, stops the boot with the rows named.
 * Running on with some of a deployment's Learning state copied and some not would quietly change which container
 * threads join and whose Skills every Bot uses.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { intelligenceCopies } from "../db/schema";
import {
  learningOpenSkills,
  learningPersonSpaces,
  learningSettings,
  learningSkillSharing,
  learningThreadBindings,
} from "../db/schema/learning";
import { recorderTrajectoryBindings } from "../db/schema/recorder";
import type { LearningIntelligence, PersonalSpace } from "./intelligence";
import { LearningVersionConflictError } from "./intelligence";
import { parseLearningSettings } from "./settings";

export const LEARNING_COPY_NAME = "learning";

/** Requests in flight at once while copying many rows. */
const PARALLEL = 16;

export type LearningCopyOutcome =
  | { kind: "done-before" }
  | {
      kind: "copied";
      settings: boolean;
      threads: number;
      spaces: number;
      sharing: number;
      trajectories: number;
    };

export class LearningCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningCopyMismatchError";
  }
}

/** The same key for the same row from every replica. Hashed: Intelligence refuses a key over 128 characters. */
function upgradeKey(kind: string, value: unknown): string {
  return `openbot-upgrade:learning:${kind}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Runs `work` over `items`, `PARALLEL` at a time, collecting each failure with its label. */
async function each<T>(
  items: readonly T[],
  label: (item: T) => string,
  work: (item: T) => Promise<void>,
): Promise<string[]> {
  const refused: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        try {
          await work(item);
        } catch (error) {
          refused.push(
            `${label(item)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }),
  );
  return refused;
}

const sameSharing = (
  space: PersonalSpace,
  mode: string,
  openSkills: readonly string[],
) =>
  space.sharing.mode === mode &&
  space.sharing.openSkills.length === new Set(openSkills).size &&
  openSkills.every((name) => space.sharing.openSkills.includes(name));

const untouchedSharing = (space: PersonalSpace) =>
  space.sharing.mode === "closed" && space.sharing.openSkills.length === 0;

export async function copyLocalLearningToIntelligence(
  database: Database,
  intelligence: LearningIntelligence,
): Promise<LearningCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, LEARNING_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const [savedSettings] = await database
    .select()
    .from(learningSettings)
    .where(eq(learningSettings.id, "current"))
    .limit(1);
  const threads = await database.select().from(learningThreadBindings);
  const spaces = await database.select().from(learningPersonSpaces);
  const sharingRows = await database.select().from(learningSkillSharing);
  const openRows = await database.select().from(learningOpenSkills);
  const trajectories = await database.select().from(recorderTrajectoryBindings);

  const refused: string[] = [];

  // The Admin settings, only when Intelligence has none saved: a choice made there since stays.
  let settingsCopied = false;
  if (savedSettings) {
    const parsed = parseLearningSettings(savedSettings.settings);
    if (!parsed.ok) {
      refused.push(`learning_settings: ${parsed.error}`);
    } else if ((await intelligence.agentAssignments()).savedAt === null) {
      try {
        await intelligence.saveAgentAssignments(
          parsed.settings,
          0,
          // The row's own time as well as its content: replicas of this deployment send the same key, and a second
          // deployment holding the same settings (or this one after a purge) is not answered with another's receipt.
          upgradeKey("settings", [
            parsed.settings,
            savedSettings.updatedAt.toISOString(),
          ]),
        );
        settingsCopied = true;
      } catch (error) {
        // Another replica, or an administrator, saved first.
        if (!(error instanceof LearningVersionConflictError))
          refused.push(
            `learning_settings: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    }
  }

  refused.push(
    ...(await each(
      threads,
      (row) => `learning_thread_bindings ${row.userId}/${row.threadId}`,
      async (row) => {
        await intelligence.assignThread(
          {
            threadId: row.threadId,
            appUserId: row.userId,
            agentId: row.agentId,
            learningContainerId: row.containerId,
            createdAt: row.createdAt,
          },
          upgradeKey("thread", [
            row.userId,
            row.threadId,
            row.agentId,
            row.containerId,
            row.createdAt.toISOString(),
          ]),
        );
      },
    )),
  );

  refused.push(
    ...(await each(
      spaces,
      (row) => `learning_person_spaces ${row.userId}`,
      async (row) => {
        await intelligence.confirmPersonalSpace(row.userId, row.containerId, {
          confirmedAt: row.createdAt,
          key: upgradeKey("space", [
            row.userId,
            row.containerId,
            row.createdAt.toISOString(),
          ]),
        });
      },
    )),
  );

  // Each person's choice and the Skills they opened, kept across modes: one save per person.
  const sharing = new Map<string, { mode: string; openSkills: string[] }>();
  for (const row of sharingRows)
    sharing.set(row.userId, { mode: row.mode, openSkills: [] });
  for (const row of openRows) {
    const entry = sharing.get(row.userId) ?? { mode: "closed", openSkills: [] };
    entry.openSkills.push(row.skillName);
    sharing.set(row.userId, entry);
  }
  const toShare = [...sharing.entries()].filter(
    ([, entry]) => entry.mode !== "closed" || entry.openSkills.length > 0,
  );
  /** People whose space already held a choice of its own, which stands. */
  const keptTheirs = new Set<string>();
  refused.push(
    ...(await each(
      toShare,
      ([userId]) => `learning_skill_sharing ${userId}`,
      async ([userId, entry]) => {
        for (let attempt = 1; ; attempt++) {
          const space = await intelligence.personalSpace(userId);
          if (sameSharing(space, entry.mode, entry.openSkills)) return;
          if (!untouchedSharing(space)) {
            keptTheirs.add(userId);
            return;
          }
          try {
            await intelligence.saveSharing(
              userId,
              {
                mode: entry.mode as PersonalSpace["sharing"]["mode"],
                openSkills: [...new Set(entry.openSkills)],
              },
              space.version,
              upgradeKey("sharing", [
                userId,
                entry.mode,
                [...new Set(entry.openSkills)].sort(),
                space.version,
              ]),
            );
            return;
          } catch (error) {
            if (
              !(error instanceof LearningVersionConflictError) ||
              attempt >= 5
            )
              throw error;
          }
        }
      },
    )),
  );

  /** Trajectories Intelligence already gives to somebody else. */
  const ownedElsewhere: string[] = [];
  refused.push(
    ...(await each(
      trajectories,
      (row) => `recorder_trajectory_bindings ${row.trajectoryId}`,
      async (row) => {
        if (!(await intelligence.claimTrajectory(row.trajectoryId, row.userId)))
          ownedElsewhere.push(row.trajectoryId);
      },
    )),
  );

  if (refused.length > 0) {
    throw new LearningCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's Learning rows, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }

  // Verify: every row is in Intelligence now.
  const missing: string[] = [];
  if (savedSettings && (await intelligence.agentAssignments()).savedAt === null)
    missing.push("learning_settings");
  const assigned = new Set(
    (await intelligence.threadAssignments()).map((row) =>
      JSON.stringify([row.appUserId, row.threadId]),
    ),
  );
  for (const row of threads)
    if (!assigned.has(JSON.stringify([row.userId, row.threadId])))
      missing.push(`learning_thread_bindings ${row.userId}/${row.threadId}`);
  const held = new Map(
    (await intelligence.personalSpaces()).map((space) => [
      space.appUserId,
      space,
    ]),
  );
  for (const row of spaces)
    if (held.get(row.userId)?.learningContainerId == null)
      missing.push(`learning_person_spaces ${row.userId}`);
  for (const [userId, entry] of toShare) {
    const space = held.get(userId);
    if (
      !space ||
      (!keptTheirs.has(userId) &&
        !sameSharing(space, entry.mode, entry.openSkills))
    )
      missing.push(`learning_skill_sharing ${userId}`);
  }
  await each(
    trajectories,
    (row) => row.trajectoryId,
    async (row) => {
      if ((await intelligence.trajectoryOwner(row.trajectoryId)) === null)
        missing.push(`recorder_trajectory_bindings ${row.trajectoryId}`);
    },
  ).then((failed) => missing.push(...failed));
  if (missing.length > 0) {
    throw new LearningCopyMismatchError(
      `This deployment's Learning rows were copied into Intelligence, and ${missing.length} are not there:\n${missing.join("\n")}`,
    );
  }

  if (ownedElsewhere.length > 0 || keptTheirs.size > 0) {
    console.warn(
      JSON.stringify({
        type: "learning-copy-kept-intelligence",
        note: "Intelligence already held these, and its answer stands: trajectories its Runtime join gave to another person, and people whose sharing choice was already saved there.",
        trajectories: ownedElsewhere,
        sharing: [...keptTheirs],
      }),
    );
  }

  const copied =
    (savedSettings ? 1 : 0) +
    threads.length +
    spaces.length +
    toShare.length +
    trajectories.length;
  await database
    .insert(intelligenceCopies)
    .values({ name: LEARNING_COPY_NAME, copied })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "learning-copied-to-intelligence",
      settings: settingsCopied,
      threads: threads.length,
      spaces: spaces.length,
      sharing: toShare.length,
      trajectories: trajectories.length,
    }),
  );
  return {
    kind: "copied",
    settings: settingsCopied,
    threads: threads.length,
    spaces: spaces.length,
    sharing: toShare.length,
    trajectories: trajectories.length,
  };
}
