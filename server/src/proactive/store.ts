import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema/core";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import { PROACTIVE_INITIATOR_PREFIX } from "./restriction";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
  type ProactiveRunStatus,
  type ProactiveSetting,
  type ProactiveSuggestion,
  parseWith,
  proactiveSettingInputSchema,
  proactiveSettingPatchSchema,
} from "./types";

/** What a proactive run read, as the audit trail recorded it. The source of truth for provenance. */
export type ProactiveRead = { ref: string; at: Date };

export function createProactiveStore(database: Database) {
  const owned = (owner: string, id: string) =>
    and(eq(proactiveSettings.ownerUserId, owner), eq(proactiveSettings.id, id));
  async function get(owner: string, id: string): Promise<ProactiveSetting> {
    const [row] = await database
      .select()
      .from(proactiveSettings)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new ProactiveNotFoundError();
    return row;
  }
  return {
    get,
    async byId(id: string): Promise<ProactiveSetting | null> {
      const [row] = await database
        .select()
        .from(proactiveSettings)
        .where(eq(proactiveSettings.id, id))
        .limit(1);
      return row ?? null;
    },
    async list(owner: string): Promise<ProactiveSetting[]> {
      return database
        .select()
        .from(proactiveSettings)
        .where(eq(proactiveSettings.ownerUserId, owner))
        .orderBy(desc(proactiveSettings.createdAt));
    },
    async create(
      owner: string,
      input: unknown,
      threadId: string,
    ): Promise<ProactiveSetting> {
      const parsed = parseWith(proactiveSettingInputSchema, input);
      const [row] = await database
        .insert(proactiveSettings)
        .values({
          id: randomUUID(),
          ownerUserId: owner,
          threadId,
          ...parsed,
        })
        .onConflictDoNothing()
        .returning();
      if (!row)
        throw new ProactiveRefusedError(
          "Background research is already set up for this Bot.",
        );
      return row;
    },
    async update(owner: string, id: string, input: unknown) {
      const patch = parseWith(proactiveSettingPatchSchema, input);
      const [row] = await database
        .update(proactiveSettings)
        .set({
          ...patch,
          ...(patch.enabled ? { nextRunAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(owned(owner, id))
        .returning();
      if (!row) throw new ProactiveNotFoundError();
      return row;
    },
    async remove(owner: string, id: string) {
      const rows = await database
        .delete(proactiveSettings)
        .where(owned(owner, id))
        .returning({ id: proactiveSettings.id });
      if (!rows.length) throw new ProactiveNotFoundError();
    },
    /**
     * Take the due settings and move each one's next run forward in the same statement, so two
     * sweeps can never both take one and the interval holds even when a run then fails.
     */
    async claimDue(limit = 5): Promise<ProactiveSetting[]> {
      const due = await database
        .select({ id: proactiveSettings.id })
        .from(proactiveSettings)
        .where(
          and(
            eq(proactiveSettings.enabled, true),
            lte(proactiveSettings.nextRunAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
      const claimed: ProactiveSetting[] = [];
      for (const { id } of due) {
        const [row] = await database
          .update(proactiveSettings)
          .set({
            nextRunAt: sql`now() + make_interval(mins => ${proactiveSettings.intervalMinutes})`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proactiveSettings.id, id),
              eq(proactiveSettings.enabled, true),
              lte(proactiveSettings.nextRunAt, new Date()),
            ),
          )
          .returning();
        if (row) claimed.push(row);
      }
      return claimed;
    },
    async recordRun(
      id: string,
      status: ProactiveRunStatus,
      error: string | null = null,
    ) {
      await database
        .update(proactiveSettings)
        .set({
          lastStatus: status,
          lastError: error?.slice(0, 500) ?? null,
          ...(status === "running" ? { lastRunAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(proactiveSettings.id, id));
    },
    /** Successful connector reads this proactive run made, from the audit trail. */
    async readsFor(runId: string): Promise<ProactiveRead[]> {
      const rows = await database
        .select({ ref: auditEvents.targetId, at: auditEvents.createdAt })
        .from(auditEvents)
        .where(
          and(
            eq(
              auditEvents.initiatorId,
              `${PROACTIVE_INITIATOR_PREFIX}${runId}`,
            ),
            eq(auditEvents.eventType, "mcp.call_succeeded"),
            gte(auditEvents.createdAt, new Date(Date.now() - 86_400_000)),
          ),
        )
        .limit(200);
      return rows.flatMap((row) =>
        row.ref ? [{ ref: row.ref, at: row.at }] : [],
      );
    },
    async countSuggestions(runId: string) {
      const [row] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(proactiveSuggestions)
        .where(eq(proactiveSuggestions.runId, runId));
      return row?.count ?? 0;
    },
    async addSuggestion(
      input: Omit<
        ProactiveSuggestion,
        "id" | "status" | "deliveredAt" | "resolvedAt" | "createdAt"
      >,
    ): Promise<ProactiveSuggestion> {
      const [row] = await database
        .insert(proactiveSuggestions)
        .values({ id: randomUUID(), ...input })
        .returning();
      if (!row) throw new Error("Suggestion insert returned no row.");
      return row;
    },
    async undelivered(runId: string): Promise<ProactiveSuggestion[]> {
      return database
        .select()
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.runId, runId),
            isNull(proactiveSuggestions.deliveredAt),
          ),
        );
    },
    async markDelivered(id: string) {
      await database
        .update(proactiveSuggestions)
        .set({ deliveredAt: new Date() })
        .where(eq(proactiveSuggestions.id, id));
    },
    async suggestions(owner: string): Promise<ProactiveSuggestion[]> {
      return database
        .select()
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.status, "open"),
          ),
        )
        .orderBy(desc(proactiveSuggestions.createdAt))
        .limit(100);
    },
    async suggestion(owner: string, id: string): Promise<ProactiveSuggestion> {
      const [row] = await database
        .select()
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.id, id),
          ),
        )
        .limit(1);
      if (!row) throw new ProactiveNotFoundError();
      return row;
    },
    /** Open to dismissed or started, once. A second click is refused rather than run twice. */
    async resolveSuggestion(
      owner: string,
      id: string,
      status: "dismissed" | "started",
    ): Promise<ProactiveSuggestion> {
      const [row] = await database
        .update(proactiveSuggestions)
        .set({ status, resolvedAt: new Date() })
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.id, id),
            eq(proactiveSuggestions.status, "open"),
          ),
        )
        .returning();
      if (!row)
        throw new ProactiveRefusedError(
          "This suggestion was already started or dismissed.",
        );
      return row;
    },
  };
}
export type ProactiveStore = ReturnType<typeof createProactiveStore>;
