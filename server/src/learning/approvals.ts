import {
  isLearnedSkillName,
  type LearningProposalDetail,
} from "@openbot/shared/learning";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { learningSkillApprovals } from "../db/schema/learning";
import type { ReviewSteps } from "./review";

/**
 * The name a proposed skill's SKILL.md gives itself in its front matter, or null when it has none or an unusable one.
 * A leading byte order mark and CRLF line endings, as editors on Windows write them, are read like any other file.
 */
export function skillNameOf(
  files: { path: string; content: string }[],
): string | null {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  const frontMatter = skillFile?.content
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = frontMatter?.[1]?.match(/^name:[ \t]*([^\r\n]*?)[ \t]*\r?$/m);
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
 * The `updated_at` an approval write set, so a later undo, or an admin deciding a request, can tell whether the row is
 * still that write. Text, not a Date: a Date keeps milliseconds and Postgres keeps microseconds. Printed in UTC with a
 * fixed pattern (`2026-11-06T10:00:00.123456Z`), never `::text`, whose form follows the session's TimeZone and
 * DateStyle, so a stamp read on one connection matches on any other. Compared as that same text, so a malformed
 * stamp matches nothing rather than failing a cast.
 */
const writtenStamp = sql<string>`to_char(${learningSkillApprovals.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const stampIs = (stamp: string) => sql`${writtenStamp} = ${stamp}`;

const stillWritten = (userId: string, skillName: string, written: string) =>
  and(approvalKey(userId, skillName), stampIs(written));

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
  ): Promise<
    | { existed: false; previous: null; previousStamp: null; written: string }
    | {
        existed: true;
        previous: SkillApproval;
        /** The `updated_at` stamp of the row replaced, so an undo can put it back exactly. */
        previousStamp: string;
        written: string;
      }
  > {
    return database.transaction(async (transaction) => {
      // A row deleted between our insert and our read sends us round again; three rounds is far past any real race.
      for (let attempt = 0; attempt < 3; attempt++) {
        const [found] = await transaction
          .select({ ...approvalColumns, stamp: writtenStamp })
          .from(learningSkillApprovals)
          .where(approvalKey(userId, skillName))
          .for("update");
        if (found) {
          const { stamp: previousStamp, ...previous } = found;
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
            return {
              existed: true as const,
              previous,
              previousStamp,
              written: updated.written,
            };
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
          return {
            existed: false as const,
            previous: null,
            previousStamp: null,
            written: created.written,
          };
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

    /** The `updated_at` stamp of a skill's approval as it stands now, or null when it has none. */
    async stampOf(userId: string, skillName: string): Promise<string | null> {
      const [row] = await database
        .select({ stamp: writtenStamp })
        .from(learningSkillApprovals)
        .where(approvalKey(userId, skillName))
        .limit(1);
      return row?.stamp ?? null;
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
     * Puts back what `recordApprovalStamped` replaced, stamp and all (`previousStamp`), but only while the row is still
     * the one it wrote (`written`). With its old stamp the row is exactly the one replaced, so an admin who opened its
     * sharing request before can still decide it, and an earlier undo waiting on that stamp still matches it. A row
     * another approval changed since, or deleted, is left alone. One conditional UPDATE is the check and the write at
     * once: under READ COMMITTED it waits for a concurrent writer's lock and then tests the stamp against the row that
     * writer committed.
     */
    async restoreIfUnchanged(
      previous: SkillApproval,
      previousStamp: string,
      written: string,
    ): Promise<boolean> {
      const restored = await database
        .update(learningSkillApprovals)
        .set({
          approvedBy: previous.approvedBy,
          sharing: previous.sharing,
          updatedAt: sql`${previousStamp}::timestamptz`,
        })
        .where(stillWritten(previous.userId, previous.skillName, written))
        .returning({ name: learningSkillApprovals.skillName });
      return restored.length > 0;
    },

    /** Deletes an approval, but only while the row is still the write stamped `written`. */
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

    /**
     * Asks to share a skill the person approved, when it is not shared and not already asked for (sharing "none" or
     * "declined"). False for any other skill or state, checked in the same statement that writes, so an admin's
     * decision that lands just before is never turned back into a request.
     */
    async requestSharing(userId: string, skillName: string): Promise<boolean> {
      const updated = await database
        .update(learningSkillApprovals)
        .set({ sharing: "requested", updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            approvalKey(userId, skillName),
            eq(learningSkillApprovals.approvedBy, "person"),
            inArray(learningSkillApprovals.sharing, ["none", "declined"]),
          ),
        )
        .returning({ name: learningSkillApprovals.skillName });
      return updated.length > 0;
    },

    /**
     * Answers a request. False when the skill is not a person's with a request waiting, or when the row changed since
     * `requestedAt` (the `updatedAt` `requests()` gave), so an admin decides only on the version they opened.
     */
    async decideSharing(
      userId: string,
      skillName: string,
      decision: "approved" | "declined",
      requestedAt: string,
    ): Promise<boolean> {
      const updated = await database
        .update(learningSkillApprovals)
        .set({ sharing: decision, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            approvalKey(userId, skillName),
            eq(learningSkillApprovals.approvedBy, "person"),
            eq(learningSkillApprovals.sharing, "requested"),
            stampIs(requestedAt),
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
 * The approval hook: records who approved a proposal in OpenBot before Intelligence is asked to publish it, and hands
 * `reviewProposal` the undo to run when Intelligence refuses. A person can't approve a skill without a usable name, since
 * OpenBot could not record it; an admin's approval of one records nothing, since an admin's skill needs no row.
 *
 * A removal is the other way round: the row stays until Intelligence has removed the skill, and only `after` deletes
 * it. While the skill is published its row keeps it held back from other people's Bots, so deleting the row first
 * would share it in the gap, and for good if the removal then failed.
 *
 * Each step acts only while the row is still what its own call left (or, for a removal, what it found), so when two
 * approvals of the same skill overlap, one's undo or removal leaves the other's row alone.
 */
export function recordApprovalBefore(
  approvals: SkillApprovalStore,
  userId: string,
  by: "person" | "admin",
): (
  detail: Pick<LearningProposalDetail, "files" | "operation">,
) => Promise<ReviewSteps> {
  return async (detail) => {
    const name = skillNameOf(detail.files);
    if (name === null) {
      if (by === "person") throw new UnnamedSkillError();
      return {};
    }
    if (detail.operation === "remove") {
      const found = await approvals.stampOf(userId, name);
      if (found === null) return {};
      return {
        after: async () => {
          await approvals.forgetIfUnchanged(userId, name, found);
        },
      };
    }
    const recorded = await approvals.recordApprovalStamped(userId, name, by);
    return {
      undo: async () => {
        if (recorded.existed)
          await approvals.restoreIfUnchanged(
            recorded.previous,
            recorded.previousStamp,
            recorded.written,
          );
        else await approvals.forgetIfUnchanged(userId, name, recorded.written);
      },
    };
  };
}
