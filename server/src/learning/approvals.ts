import { isLearnedSkillName } from "@openbot/shared/learning";
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

/** Who approved each skill in a person's own space, and where a person's request to share it with every Bot stands. */
export function createSkillApprovalStore(database: Database) {
  return {
    async get(
      userId: string,
      skillName: string,
    ): Promise<SkillApproval | null> {
      const [row] = await database
        .select({
          userId: learningSkillApprovals.userId,
          skillName: learningSkillApprovals.skillName,
          approvedBy: learningSkillApprovals.approvedBy,
          sharing: learningSkillApprovals.sharing,
        })
        .from(learningSkillApprovals)
        .where(approvalKey(userId, skillName))
        .limit(1);
      return row ?? null;
    },

    /**
     * Records an approval and says whether the skill already had one, and what that one was, so a caller that has to
     * take the approval back can `forget` a row it created or `restore` the row it replaced. A person's approval of a
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
      return database.transaction(async (transaction) => {
        // A row deleted between our insert and our read sends us round again; three rounds is far past any real race.
        for (let attempt = 0; attempt < 3; attempt++) {
          const [previous] = await transaction
            .select({
              userId: learningSkillApprovals.userId,
              skillName: learningSkillApprovals.skillName,
              approvedBy: learningSkillApprovals.approvedBy,
              sharing: learningSkillApprovals.sharing,
            })
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
            await transaction
              .update(learningSkillApprovals)
              .set({ approvedBy: by, sharing, updatedAt: new Date() })
              .where(approvalKey(userId, skillName));
            return { existed: true, previous };
          }
          const created = await transaction
            .insert(learningSkillApprovals)
            .values({ userId, skillName, approvedBy: by, sharing: "none" })
            .onConflictDoNothing({
              target: [
                learningSkillApprovals.userId,
                learningSkillApprovals.skillName,
              ],
            })
            .returning({ skillName: learningSkillApprovals.skillName });
          if (created.length > 0) return { existed: false, previous: null };
        }
        throw new Error(
          `The approval of skill "${skillName}" kept changing while it was being recorded.`,
        );
      });
    },

    /** Writes back an approval exactly as `recordApproval` reported it before replacing it. */
    async restore(previous: SkillApproval): Promise<void> {
      await database
        .insert(learningSkillApprovals)
        .values({
          userId: previous.userId,
          skillName: previous.skillName,
          approvedBy: previous.approvedBy,
          sharing: previous.sharing,
        })
        .onConflictDoUpdate({
          target: [
            learningSkillApprovals.userId,
            learningSkillApprovals.skillName,
          ],
          set: {
            approvedBy: previous.approvedBy,
            sharing: previous.sharing,
            updatedAt: new Date(),
          },
        });
    },

    async forget(userId: string, skillName: string): Promise<void> {
      await database
        .delete(learningSkillApprovals)
        .where(approvalKey(userId, skillName));
    },

    /** Asks to share a skill the person approved. False for any other skill. */
    async requestSharing(userId: string, skillName: string): Promise<boolean> {
      const updated = await database
        .update(learningSkillApprovals)
        .set({ sharing: "requested", updatedAt: new Date() })
        .where(
          and(
            approvalKey(userId, skillName),
            eq(learningSkillApprovals.approvedBy, "person"),
          ),
        )
        .returning({ name: learningSkillApprovals.skillName });
      return updated.length > 0;
    },

    /** Answers a request. False when the skill is not a person's with a request waiting. */
    async decideSharing(
      userId: string,
      skillName: string,
      decision: "approved" | "declined",
    ): Promise<boolean> {
      const updated = await database
        .update(learningSkillApprovals)
        .set({ sharing: decision, updatedAt: new Date() })
        .where(
          and(
            approvalKey(userId, skillName),
            eq(learningSkillApprovals.approvedBy, "person"),
            eq(learningSkillApprovals.sharing, "requested"),
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
          updatedAt: learningSkillApprovals.updatedAt,
        })
        .from(learningSkillApprovals)
        .where(eq(learningSkillApprovals.sharing, "requested"))
        .orderBy(asc(learningSkillApprovals.updatedAt));
      return rows.map((row) => ({
        userId: row.userId,
        skillName: row.skillName,
        updatedAt: row.updatedAt.toISOString(),
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
