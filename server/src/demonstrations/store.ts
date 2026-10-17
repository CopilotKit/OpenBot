import { randomUUID } from "node:crypto";
import { hasTarget } from "@openbot/shared/demonstration-schema";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  demonstrationSteps,
  demonstrations,
} from "../db/schema/demonstrations";
import { draftDemonstration } from "./draft";
import {
  DEMONSTRATION_MAX_DURATION_MS,
  type DemonstrationAction,
  DemonstrationGapError,
  DemonstrationNotFoundError,
  DemonstrationOpenError,
  DemonstrationRefusedError,
  type DemonstrationSource,
  demonstrationExpiresAt,
  parseDemonstrationAction,
  reachedDemonstrationTimeLimit,
} from "./types";

type DemonstrationRow = typeof demonstrations.$inferSelect;
/** The ten-minute bound as a database interval, so expiry uses the database clock. */
const limit = () =>
  sql`(${DEMONSTRATION_MAX_DURATION_MS}::integer * interval '1 millisecond')`;
/**
 * A recording as the API returns it: its row plus when the server stops it (never, for an extension
 * recording) and how many steps it holds. An extension recording keeps its steps in
 * demonstration_steps while it records, so its count is the row's stepCount until Stop folds them in.
 */
function present(row: DemonstrationRow) {
  const extension = row.source === "extension";
  return {
    ...row,
    actionCount:
      extension && row.status === "recording"
        ? row.stepCount
        : row.actions.length,
    expiresAt: extension ? null : demonstrationExpiresAt(row.createdAt),
    maxDurationMs: extension ? null : DEMONSTRATION_MAX_DURATION_MS,
    reachedTimeLimit: extension ? false : reachedDemonstrationTimeLimit(row),
  };
}
export function createDemonstrationStore(database: Database) {
  /**
   * Stops this owner's recordings that have run past ten minutes. Called before every read, so the
   * bound holds even when no timer fired (another replica, a restart): the recording ends at its
   * limit, never later, whichever process looks first.
   */
  async function expireOverdue(ownerUserId: string) {
    await database
      .update(demonstrations)
      .set({
        status: "stopped",
        finishedAt: sql`${demonstrations.createdAt} + ${limit()}`,
      })
      .where(
        and(
          eq(demonstrations.ownerUserId, ownerUserId),
          eq(demonstrations.status, "recording"),
          eq(demonstrations.source, "computer"),
          sql`${demonstrations.createdAt} + ${limit()} <= now()`,
        ),
      );
  }
  async function get(ownerUserId: string, id: string) {
    await expireOverdue(ownerUserId);
    const [row] = await database
      .select()
      .from(demonstrations)
      .where(
        and(
          eq(demonstrations.id, id),
          eq(demonstrations.ownerUserId, ownerUserId),
        ),
      );
    if (!row) throw new DemonstrationNotFoundError();
    return present(row);
  }
  /** This person's open extension recording for the Bot, if any. */
  async function openExtension(ownerUserId: string, botId: string) {
    const [row] = await database
      .select()
      .from(demonstrations)
      .where(
        and(
          eq(demonstrations.ownerUserId, ownerUserId),
          eq(demonstrations.botId, botId),
          eq(demonstrations.status, "recording"),
          eq(demonstrations.source, "extension"),
        ),
      );
    return row ? present(row) : null;
  }
  return {
    get,
    expireOverdue,
    async list(ownerUserId: string, botId: string) {
      await expireOverdue(ownerUserId);
      const rows = await database
        .select()
        .from(demonstrations)
        .where(
          and(
            eq(demonstrations.ownerUserId, ownerUserId),
            eq(demonstrations.botId, botId),
          ),
        )
        .orderBy(desc(demonstrations.createdAt))
        .limit(30);
      return rows.map(present);
    },
    async active(ownerUserId: string, botId: string) {
      await expireOverdue(ownerUserId);
      const [row] = await database
        .select()
        .from(demonstrations)
        .where(
          and(
            eq(demonstrations.ownerUserId, ownerUserId),
            eq(demonstrations.botId, botId),
            eq(demonstrations.status, "recording"),
            eq(demonstrations.source, "computer"),
          ),
        );
      return row ? present(row) : null;
    },
    openExtension,
    async start(
      ownerUserId: string,
      botId: string,
      title: string,
      source: DemonstrationSource = "computer",
    ) {
      const clean = title.trim();
      if (!clean || clean.length > 120)
        throw new DemonstrationRefusedError(
          "Name this demonstration in 120 characters or fewer.",
        );
      const [row] = await database
        .insert(demonstrations)
        .values({ id: randomUUID(), ownerUserId, botId, title: clean, source })
        .onConflictDoNothing()
        .returning();
      if (!row && source === "extension") {
        const open = await openExtension(ownerUserId, botId);
        if (open) throw new DemonstrationOpenError(open.id);
      }
      if (!row)
        throw new DemonstrationRefusedError(
          "This Bot already has an active demonstration. Stop it before starting another.",
        );
      return present(row);
    },
    async append(ownerUserId: string, id: string, input: unknown) {
      const action = parseDemonstrationAction(input);
      const outcome = await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({
            ...getTableColumns(demonstrations),
            overdue: sql<boolean>`${demonstrations.createdAt} + ${limit()} <= now()`,
          })
          .from(demonstrations)
          .where(
            and(
              eq(demonstrations.id, id),
              eq(demonstrations.ownerUserId, ownerUserId),
            ),
          )
          .for("update");
        if (!row) throw new DemonstrationNotFoundError();
        if (row.source !== "computer")
          throw new DemonstrationRefusedError(
            "This recording is being made in a browser, not in the Bot's computer.",
          );
        if (row.status !== "recording") return "kept";
        if (row.overdue) {
          await transaction
            .update(demonstrations)
            .set({
              status: "stopped",
              finishedAt: sql`${demonstrations.createdAt} + ${limit()}`,
            })
            .where(eq(demonstrations.id, id));
          return "expired";
        }
        const last = row.actions.at(-1);
        if (
          action.kind === "type" &&
          last?.kind === "type" &&
          hasTarget(last) &&
          last.url === action.url &&
          // Field by field: jsonb reorders object keys, so a stringified comparison never matched.
          last.target.role === action.target.role &&
          last.target.name === action.target.name &&
          last.target.sensitive === action.target.sensitive
        )
          return "kept";
        if (row.actions.length >= 200) {
          await transaction
            .update(demonstrations)
            .set({ status: "stopped", finishedAt: new Date() })
            .where(eq(demonstrations.id, id));
          return "full";
        }
        await transaction
          .update(demonstrations)
          .set({ actions: [...row.actions, action] })
          .where(eq(demonstrations.id, id));
        return "kept";
      });
      if (outcome === "expired")
        throw new DemonstrationRefusedError(
          "The demonstration reached its ten-minute limit and has stopped. Review its draft.",
        );
      if (outcome === "full")
        throw new DemonstrationRefusedError(
          "The demonstration reached 200 steps and has stopped. Review its draft.",
        );
    },
    /**
     * Stores the steps from `fromIndex` on, returning how many the recording holds. Steps it already
     * holds are skipped, so a resent or overlapping batch is harmless; a batch that starts beyond them
     * is a gap. Only the batch's own rows are written, however long the recording is.
     */
    async appendBatch(
      ownerUserId: string,
      id: string,
      fromIndex: number,
      actions: unknown[],
    ) {
      const parsed = actions.map(parseDemonstrationAction);
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({
            status: demonstrations.status,
            source: demonstrations.source,
            stepCount: demonstrations.stepCount,
          })
          .from(demonstrations)
          .where(
            and(
              eq(demonstrations.id, id),
              eq(demonstrations.ownerUserId, ownerUserId),
            ),
          )
          .for("update");
        if (!row) throw new DemonstrationNotFoundError();
        if (row.source !== "extension" || row.status !== "recording")
          throw new DemonstrationRefusedError(
            "This recording is not taking steps from a browser.",
          );
        if (fromIndex > row.stepCount)
          throw new DemonstrationGapError(row.stepCount);
        const fresh = parsed.slice(row.stepCount - fromIndex);
        if (fresh.length === 0) return row.stepCount;
        const total = row.stepCount + fresh.length;
        await transaction.insert(demonstrationSteps).values(
          fresh.map((action, offset) => ({
            demonstrationId: id,
            index: row.stepCount + offset,
            action,
          })),
        );
        await transaction
          .update(demonstrations)
          .set({ stepCount: total })
          .where(eq(demonstrations.id, id));
        return total;
      });
    },
    async stop(ownerUserId: string, id: string) {
      await get(ownerUserId, id);
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ source: demonstrations.source })
          .from(demonstrations)
          .where(
            and(
              eq(demonstrations.id, id),
              eq(demonstrations.ownerUserId, ownerUserId),
              eq(demonstrations.status, "recording"),
            ),
          )
          .for("update");
        if (!row) return;
        const folded =
          row.source === "extension"
            ? {
                actions: sql<
                  DemonstrationAction[]
                >`(select coalesce(jsonb_agg(${demonstrationSteps.action} order by ${demonstrationSteps.index}), '[]'::jsonb) from ${demonstrationSteps} where ${demonstrationSteps.demonstrationId} = ${id})`,
              }
            : {};
        await transaction
          .update(demonstrations)
          .set({ status: "stopped", finishedAt: new Date(), ...folded })
          .where(eq(demonstrations.id, id));
        if (row.source === "extension")
          await transaction
            .delete(demonstrationSteps)
            .where(eq(demonstrationSteps.demonstrationId, id));
      });
      return get(ownerUserId, id);
    },
    async draft(ownerUserId: string, id: string) {
      const row = await get(ownerUserId, id);
      if (row.status === "recording")
        throw new DemonstrationRefusedError(
          "Stop recording before drafting the skill.",
        );
      if (row.status === "published")
        throw new DemonstrationRefusedError(
          "This demonstration already has a saved skill. Edit it from Skills.",
        );
      const draft = draftDemonstration(row);
      await database
        .update(demonstrations)
        .set({ draft, status: "drafted" })
        .where(
          and(
            eq(demonstrations.id, id),
            eq(demonstrations.ownerUserId, ownerUserId),
          ),
        );
      return draft;
    },
    async markPublished(ownerUserId: string, id: string, skillSlug: string) {
      const row = await get(ownerUserId, id);
      if (row.status === "recording")
        throw new DemonstrationRefusedError(
          "Stop recording before saving a skill.",
        );
      await database
        .update(demonstrations)
        .set({ status: "published", skillSlug })
        .where(
          and(
            eq(demonstrations.id, id),
            eq(demonstrations.ownerUserId, ownerUserId),
          ),
        );
      return get(ownerUserId, id);
    },
    async remove(ownerUserId: string, id: string) {
      const [row] = await database
        .delete(demonstrations)
        .where(
          and(
            eq(demonstrations.id, id),
            eq(demonstrations.ownerUserId, ownerUserId),
          ),
        )
        .returning({ id: demonstrations.id });
      if (!row) throw new DemonstrationNotFoundError();
    },
  };
}
export type DemonstrationStore = ReturnType<typeof createDemonstrationStore>;
