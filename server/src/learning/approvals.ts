import {
  isLearnedSkillName,
  type LearningProposalDetail,
} from "@openbot/shared/learning";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { learningSkillApprovals } from "../db/schema/learning";

/** The name a proposed skill's SKILL.md gives itself in its front matter, or null when it has none or an unusable one. */
export function skillNameOf(
  files: { path: string; content: string }[],
): string | null {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  const frontMatter = skillFile?.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = frontMatter?.[1]?.match(/^name:[ \t]*(.*?)[ \t]*$/m);
  if (!line) return null;
  const name = (line[1] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();
  return isLearnedSkillName(name) ? name : null;
}

export type SkillApproval = {
  userId: string;
  skillName: string;
  approvedBy: "person" | "admin";
  sharing: "none" | "requested" | "approved" | "declined";
};

const approvalKey = (userId: string, skillName: string) =>
  and(
    eq(learningSkillApprovals.userId, userId),
    eq(learningSkillApprovals.skillName, skillName),
  );

const approvalColumns = {
  userId: learningSkillApprovals.userId,
  skillName: learningSkillApprovals.skillName,
  approvedBy: learningSkillApprovals.approvedBy,
  sharing: learningSkillApprovals.sharing,
};

/**
 * The `updated_at` an approval write set, as Postgres prints it, so a later undo can tell whether the row is still
 * that write. Text, not a Date: a Date keeps milliseconds and Postgres keeps microseconds.
 */
const writtenStamp = sql<string>`${learningSkillApprovals.updatedAt}::text`;

const stillWritten = (userId: string, skillName: string, written: string) =>
  and(
    approvalKey(userId, skillName),
    sql`${learningSkillApprovals.updatedAt} = ${written}::timestamptz`,
  );

/** Who approved each skill in a person's own space, and where a person's request to share it with every Bot stands. */
export function createSkillApprovalStore(database: Database) {
  /**
   * `recordApproval`, also saying what it wrote (`written`, the row's new `updated_at`), so its undo can act only
   * while the row is still exactly this write: see `forgetIfUnchanged` and `restoreIfUnchanged`. The write stamps
   * `clock_timestamp()`, not the transaction's start time, so a later write to the same row, which has to wait for
   * this one's lock, always stamps a different time.
   */
  async function recordApprovalStamped(
    userId: string,
    skillName: string,
    by: "person" | "admin",
  ): Promise<{
    existed: boolean;
    previous: SkillApproval | null;
    written: string;
  }> {
    return database.transaction(async (transaction) => {
      // A row deleted between our insert and our read sends us round again; three rounds is far past any real race.
      for (let attempt = 0; attempt < 3; attempt++) {
        const [previous] = await transaction
          .select(approvalColumns)
          .from(learningSkillApprovals)
          .where(approvalKey(userId, skillName))
          .for("update");
        if (previous) {
          const sharing =
            by === "admin"
              ? "none"
              : previous.sharing === "approved"
                ? "requested"
                : previous.sharing;
          const [updated] = await transaction
            .update(learningSkillApprovals)
            .set({
              approvedBy: by,
              sharing,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(approvalKey(userId, skillName))
            .returning({ written: writtenStamp });
          if (updated) {
            return { existed: true, previous, written: updated.written };
          }
          continue;
        }
        const [created] = await transaction
          .insert(learningSkillApprovals)
          .values({
            userId,
            skillName,
            approvedBy: by,
            sharing: "none",
            updatedAt: sql`clock_timestamp()`,
          })
          .onConflictDoNothing({
            target: [
              learningSkillApprovals.userId,
              learningSkillApprovals.skillName,
            ],
          })
          .returning({ written: writtenStamp });
        if (created) {
          return { existed: false, previous: null, written: created.written };
        }
      }
      throw new Error(
        `The approval of skill "${skillName}" kept changing while it was being recorded.`,
      );
    });
  }

  return {
    async get(
      userId: string,
      skillName: string,
    ): Promise<SkillApproval | null> {
      const [row] = await database
        .select(approvalColumns)
        .from(learningSkillApprovals)
        .where(approvalKey(userId, skillName))
        .limit(1);
      return row ?? null;
    },

    recordApprovalStamped,

    /**
     * Records an approval and says whether the skill already had one, and what that one was, so a caller that has to
     * take the approval back can `forget` a row it created or write back the row it replaced. A person's approval of a
     * skill already approved for sharing asks for sharing again, since what was shared has changed; an admin's
     * approval clears sharing; a new row starts with no sharing.
     *
     * Why two statements and not one upsert: on Postgres 17 an `INSERT … ON CONFLICT DO UPDATE` cannot return the row
     * it replaced (`RETURNING old.*` arrives in 18), and a read in the same statement, CTE or not, runs on the
     * statement's snapshot, so it misses a row a concurrent first approval inserts and commits while this one waits
     * on the unique index. So: lock the existing row with `FOR UPDATE` and update it, which makes the read exactly the
     * row replaced; or, when there is none, insert with `ON CONFLICT DO NOTHING`, which waits for a concurrent insert
     * of the same key and lets exactly one caller create the row. A caller that loses that race reads again (each
     * statement takes a fresh snapshot under READ COMMITTED) and finds the winner's row to lock and update.
     */
    async recordApproval(
      userId: string,
      skillName: string,
      by: "person" | "admin",
    ): Promise<{ existed: boolean; previous: SkillApproval | null }> {
      const { existed, previous } = await recordApprovalStamped(
        userId,
        skillName,
        by,
      );
      return { existed, previous };
    },

    /**
     * Puts back what `recordApprovalStamped` replaced, but only while the row is still the one it wrote (`written`).
     * A row another approval changed since, or deleted, is left alone. One conditional UPDATE is the check and the
     * write at once: under READ COMMITTED it waits for a concurrent writer's lock and then tests the stamp against the
     * row that writer committed.
     */
    async restoreIfUnchanged(
      previous: SkillApproval,
      written: string,
    ): Promise<boolean> {
      const restored = await database
        .update(learningSkillApprovals)
        .set({
          approvedBy: previous.approvedBy,
          sharing: previous.sharing,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(stillWritten(previous.userId, previous.skillName, written))
        .returning({ name: learningSkillApprovals.skillName });
      return restored.length > 0;
    },

    /**
     * Puts back an approval `forget` deleted, unless the skill has been approved again since. The row returns with the
     * `stamp` it had when deleted, so it is exactly the row that was removed and an undo still waiting on that stamp
     * (`forgetIfUnchanged`, `restoreIfUnchanged`) still matches it.
     */
    async restoreIfAbsent(
      previous: SkillApproval,
      stamp: string,
    ): Promise<boolean> {
      const restored = await database
        .insert(learningSkillApprovals)
        .values({
          userId: previous.userId,
          skillName: previous.skillName,
          approvedBy: previous.approvedBy,
          sharing: previous.sharing,
          updatedAt: sql`${stamp}::timestamptz`,
        })
        .onConflictDoNothing({
          target: [
            learningSkillApprovals.userId,
            learningSkillApprovals.skillName,
          ],
        })
        .returning({ name: learningSkillApprovals.skillName });
      return restored.length > 0;
    },

    /** Deletes an approval and returns what it deleted and its `updated_at` stamp, or null when there was none. */
    async forget(
      userId: string,
      skillName: string,
    ): Promise<{ row: SkillApproval; stamp: string } | null> {
      const [deleted] = await database
        .delete(learningSkillApprovals)
        .where(approvalKey(userId, skillName))
        .returning({ ...approvalColumns, stamp: writtenStamp });
      if (!deleted) return null;
      const { stamp, ...row } = deleted;
      return { row, stamp };
    },

    /** Deletes the approval `recordApprovalStamped` created, but only while the row is still that write (`written`). */
    async forgetIfUnchanged(
      userId: string,
      skillName: string,
      written: string,
    ): Promise<boolean> {
      const deleted = await database
        .delete(learningSkillApprovals)
        .where(stillWritten(userId, skillName, written))
        .returning({ name: learningSkillApprovals.skillName });
      return deleted.length > 0;
    },

    /** Asks to share a skill the person approved. False for any other skill. */
    async requestSharing(userId: string, skillName: string): Promise<boolean> {
      const updated = await database
        .update(learningSkillApprovals)
        .set({ sharing: "requested", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            approvalKey(userId, skillName),
            eq(learningSkillApprovals.approvedBy, "person"),
          ),
        )
        .returning({ name: learningSkillApprovals.skillName });
      return updated.length > 0;
    },

    /**
     * Answers a request. False when the skill is not a person's with a request waiting. With `requestedAt` (the
     * `updatedAt` `requests()` gave), also false once the row changed since, so an admin decides only on the
     * version they opened.
     */
    async decideSharing(
      userId: string,
      skillName: string,
      decision: "approved" | "declined",
      requestedAt?: string,
    ): Promise<boolean> {
      const updated = await database
        .update(learningSkillApprovals)
        .set({ sharing: decision, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            approvalKey(userId, skillName),
            eq(learningSkillApprovals.approvedBy, "person"),
            eq(learningSkillApprovals.sharing, "requested"),
            requestedAt === undefined
              ? undefined
              : sql`${learningSkillApprovals.updatedAt} = ${requestedAt}::timestamptz`,
          ),
        )
        .returning({ name: learningSkillApprovals.skillName });
      return updated.length > 0;
    },

    /** Requests waiting for an administrator, oldest first. */
    async requests(): Promise<
      { userId: string; skillName: string; updatedAt: string }[]
    > {
      const rows = await database
        .select({
          userId: learningSkillApprovals.userId,
          skillName: learningSkillApprovals.skillName,
          updatedAt: writtenStamp,
        })
        .from(learningSkillApprovals)
        .where(eq(learningSkillApprovals.sharing, "requested"))
        .orderBy(asc(learningSkillApprovals.updatedAt));
      return rows.map((row) => ({
        userId: row.userId,
        skillName: row.skillName,
        updatedAt: row.updatedAt,
      }));
    },

    /** Per person, the skills they approved themselves that are not approved for every Bot. */
    async withheld(userIds: string[]): Promise<Map<string, Set<string>>> {
      const byPerson = new Map<string, Set<string>>();
      if (userIds.length === 0) return byPerson;
      const rows = await database
        .select({
          userId: learningSkillApprovals.userId,
          skillName: learningSkillApprovals.skillName,
        })
        .from(learningSkillApprovals)
        .where(
          and(
            inArray(learningSkillApprovals.userId, userIds),
            eq(learningSkillApprovals.approvedBy, "person"),
            sql`${learningSkillApprovals.sharing} <> 'approved'`,
          ),
        );
      for (const row of rows) {
        let names = byPerson.get(row.userId);
        if (!names) {
          names = new Set();
          byPerson.set(row.userId, names);
        }
        names.add(row.skillName);
      }
      return byPerson;
    },
  };
}
export type SkillApprovalStore = ReturnType<typeof createSkillApprovalStore>;

export class UnnamedSkillError extends Error {
  constructor() {
    super(
      "This skill has no name OpenBot can record, so it can't be approved here.",
    );
    this.name = "UnnamedSkillError";
  }
}

/**
 * The approval hook: records who approved a proposal in OpenBot before Intelligence is asked to publish it, and returns
 * the undo to call when Intelligence refuses. A person can't approve a skill without a usable name, since OpenBot could
 * not record it; an admin's approval of one records nothing, since an admin's skill needs no row.
 *
 * Each undo acts only while the row is still what its own call left, so when two approvals of the same skill overlap
 * and the first is refused, its undo leaves the second's row alone.
 */
export function recordApprovalBefore(
  approvals: SkillApprovalStore,
  userId: string,
  by: "person" | "admin",
): (
  detail: Pick<LearningProposalDetail, "files" | "operation">,
) => Promise<() => Promise<void>> {
  return async (detail) => {
    const name = skillNameOf(detail.files);
    if (name === null) {
      if (by === "person") throw new UnnamedSkillError();
      return async () => {};
    }
    if (detail.operation === "remove") {
      const removed = await approvals.forget(userId, name);
      return async () => {
        if (removed) {
          await approvals.restoreIfAbsent(removed.row, removed.stamp);
        }
      };
    }
    const { previous, written } = await approvals.recordApprovalStamped(
      userId,
      name,
      by,
    );
    return async () => {
      if (previous) await approvals.restoreIfUnchanged(previous, written);
      else await approvals.forgetIfUnchanged(userId, name, written);
    };
  };
}
