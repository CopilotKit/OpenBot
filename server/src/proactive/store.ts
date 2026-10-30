import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditEvents, users } from "../db/schema/core";
import { botLifecycle } from "../db/schema/lifecycle";
import {
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import { botTasks } from "../db/schema/tasks";
import { workItems } from "../db/schema/work";
import { lockDefaults, recordOptOut } from "../memory/defaults";
import type {
  ProactiveRunOutcome,
  ProactiveRunTrigger,
  ProactiveSkipReason,
} from "./contracts";
import { createPingStore } from "./ping";
import { PROACTIVE_INITIATOR_PREFIX } from "./restriction";
import {
  HIDDEN_DAYS,
  ProactiveNotFoundError,
  ProactiveRefusedError,
  type ProactiveRunStatus,
  type ProactiveSetting,
  type ProactiveSuggestion,
  parseWith,
  proactiveSettingInputSchema,
  proactiveSettingPatchSchema,
  titleKey,
} from "./types";
import type { LastCheckIn } from "./window";

/** The work queue kind a check-in is queued as, by the sweep and by Run now. */
export const PROACTIVE_RUN_KIND = "proactive.run";

/** The error a check-in left running past its lease is closed with: its replica stopped. */
export const STOPPED_BEFORE_FINISHING =
  "This check-in stopped before it finished.";

/** What a proactive run read, as the audit trail recorded it. The source of truth for provenance. */
export type ProactiveRead = { ref: string; at: Date };

/**
 * What this person had from this Bot before a check-in: what the repeat check refuses against, and
 * what the check-in is told (`window.ts`). Titles and links, never the mail they came from.
 */
export type PriorItems = {
  open: { id: string; title: string; sourceLink: string | null }[];
  tasks: { title: string; sourceLink: string | null }[];
  hidden: {
    title: string;
    sourceLink: string | null;
    sourceApp: string | null;
  }[];
  started: { title: string }[];
};

/** A setting's run as the ledger keeps it. */
/**
 * How long the run ledger and old pings are kept: the admin's longest window of numbers, and as long
 * as Hide holds. Nothing reads further back: the daily cap reads a day and the window reads the last
 * check-in, which after a month away is the last day anyway.
 */
export const PROACTIVE_LEDGER_DAYS = 30;
/** How many rows one prune statement removes, so a deployment that never pruned stays writable. */
const PRUNE_BATCH = 5_000;
/** How many batches one prune runs before leaving the rest for the next. */
const PRUNE_BATCHES = 20;

export type ProactiveRunRow = {
  id: string;
  settingId: string;
  outcome: ProactiveRunOutcome;
  skipReason: ProactiveSkipReason | null;
  trigger: ProactiveRunTrigger;
  threadId: string | null;
  itemsRaised: number;
  reads: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/** Whether `error` is a Postgres unique_violation on `constraint`. Bun's driver; drizzle wraps it as `cause`. */
function violates(error: unknown, constraint: string): boolean {
  type Driver = { errno?: unknown; constraint?: unknown };
  return [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ].some(
    (candidate) =>
      candidate?.errno === "23505" && candidate.constraint === constraint,
  );
}

/**
 * A setting the sweep may claim: on, and its person has not turned check-ins off for all their Bots
 * or paused this Bot. The run checks both again before the model (a switch flipped after the claim,
 * or a Run now), where it records why it stopped; here they keep a turned-off person's settings from
 * being claimed, and so from costing even a ledger row, every hour.
 */
const claimable = and(
  eq(proactiveSettings.enabled, true),
  sql`not exists (select 1 from ${users} where ${users.id} = ${proactiveSettings.ownerUserId} and ${users.preferences}->>'proactive' = 'off')`,
  sql`not exists (select 1 from ${botLifecycle} where ${botLifecycle.ownerUserId} = ${proactiveSettings.ownerUserId} and ${botLifecycle.agentId} = ${proactiveSettings.agentId} and ${botLifecycle.pausedAt} is not null)`,
);

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
    /** The person's hourly ping slot and the pings it lets through (`ping.ts`). */
    pings: createPingStore(database),
    /** This person's setting for this Bot, if they have one: there is at most one. */
    async forBot(
      owner: string,
      agentId: string,
    ): Promise<ProactiveSetting | null> {
      const [row] = await database
        .select()
        .from(proactiveSettings)
        .where(
          and(
            eq(proactiveSettings.ownerUserId, owner),
            eq(proactiveSettings.agentId, agentId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
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
    /**
     * Check-ins turned on for a Bot. The first one runs an interval from now, as the default a first
     * conversation writes does: turning them on is not asking for one now, which is Run now's job.
     */
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
          nextRunAt: sql`now() + make_interval(mins => ${parsed.intervalMinutes}::int)`,
        })
        .onConflictDoNothing()
        .returning();
      if (!row)
        throw new ProactiveRefusedError(
          "Check-ins are already set up for this Bot.",
        );
      return row;
    },
    /**
     * Change only what was sent. Off stays off until the person turns it on, whatever else they
     * change, and nothing here starts a check-in: Run now does that, behind its own gap.
     *
     * When the next check-in is due follows from the change, decided in the statement against the
     * row as it stands: turned on from off, one interval out (the interval sent, or the one it has);
     * a new interval while on, no later than one new interval out, so going from daily to hourly is
     * felt within the hour; anything else, as it was.
     */
    async update(owner: string, id: string, input: unknown) {
      const patch = parseWith(proactiveSettingPatchSchema, input);
      const minutes =
        patch.intervalMinutes ?? sql`${proactiveSettings.intervalMinutes}`;
      const oneIntervalOut = sql`now() + make_interval(mins => ${minutes}::int)`;
      const kept =
        patch.intervalMinutes === undefined
          ? sql`${proactiveSettings.nextRunAt}`
          : sql`least(${proactiveSettings.nextRunAt}, ${oneIntervalOut})`;
      const [row] = await database
        .update(proactiveSettings)
        .set({
          ...patch,
          nextRunAt:
            patch.enabled === true
              ? sql`case when ${proactiveSettings.enabled} then ${kept} else ${oneIntervalOut} end`
              : kept,
          updatedAt: new Date(),
        })
        .where(owned(owner, id))
        .returning();
      if (!row) throw new ProactiveNotFoundError();
      return row;
    },
    /** Removing research is turning it down for this Bot: OpenBot never switches it back on. */
    async remove(owner: string, id: string) {
      const { agentId } = await get(owner, id);
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, owner, agentId);
        const rows = await transaction
          .delete(proactiveSettings)
          .where(owned(owner, id))
          .returning({ id: proactiveSettings.id });
        if (!rows.length) throw new ProactiveNotFoundError();
        await recordOptOut(transaction, {
          ownerUserId: owner,
          agentId,
          feature: "proactive_research",
        });
      });
    },
    /**
     * Take the due settings and move each one's next run forward in the same statement, so two
     * sweeps can never both take one and the interval holds even when a run then fails.
     */
    async claimDue(limit = 5): Promise<ProactiveSetting[]> {
      const due = await database
        .select({ id: proactiveSettings.id })
        .from(proactiveSettings)
        .where(and(claimable, lte(proactiveSettings.nextRunAt, new Date())))
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
    /**
     * Open a new item. Its normalized title goes in `dedupe_key`, so when two check-ins race to open
     * the same thing for one person and Bot, the partial unique index lets one in and the other is
     * refused here as the repeat it is.
     */
    async addSuggestion(
      input: Omit<
        ProactiveSuggestion,
        | "id"
        | "status"
        | "dedupeKey"
        | "pingId"
        | "deliveredAt"
        | "resolvedAt"
        | "createdAt"
      >,
    ): Promise<ProactiveSuggestion> {
      try {
        const [row] = await database
          .insert(proactiveSuggestions)
          .values({
            id: randomUUID(),
            ...input,
            dedupeKey: titleKey(input.title),
          })
          .returning();
        if (!row) throw new Error("Suggestion insert returned no row.");
        return row;
      } catch (error) {
        if (violates(error, "proactive_suggestions_open_dedupe_idx"))
          throw new ProactiveRefusedError(
            "This is already raised and still open. Do not raise it again.",
          );
        throw error;
      }
    },
    /**
     * What this person had from this Bot: items still open, unfinished tasks, and what they hid or
     * started in the last thirty days, newest first. Read fresh for each item a check-in raises, so
     * an item another check-in opened a moment ago counts too.
     */
    async priorItems(owner: string, agentId: string): Promise<PriorItems> {
      const since = new Date(Date.now() - HIDDEN_DAYS * 86_400_000);
      const mine = and(
        eq(proactiveSuggestions.ownerUserId, owner),
        eq(proactiveSuggestions.agentId, agentId),
      );
      const columns = {
        id: proactiveSuggestions.id,
        title: proactiveSuggestions.title,
        sourceLink: proactiveSuggestions.sourceLink,
        sourceApp: proactiveSuggestions.sourceApp,
      };
      const [open, hidden, started, tasks] = await Promise.all([
        database
          .select(columns)
          .from(proactiveSuggestions)
          .where(and(mine, eq(proactiveSuggestions.status, "open")))
          .orderBy(desc(proactiveSuggestions.createdAt))
          .limit(50),
        database
          .select(columns)
          .from(proactiveSuggestions)
          .where(
            and(
              mine,
              eq(proactiveSuggestions.status, "dismissed"),
              gte(proactiveSuggestions.resolvedAt, since),
            ),
          )
          .orderBy(desc(proactiveSuggestions.resolvedAt))
          .limit(50),
        database
          .select(columns)
          .from(proactiveSuggestions)
          .where(
            and(
              mine,
              eq(proactiveSuggestions.status, "started"),
              gte(proactiveSuggestions.resolvedAt, since),
            ),
          )
          .orderBy(desc(proactiveSuggestions.resolvedAt))
          .limit(20),
        database
          .select({ title: botTasks.title, sourceLink: botTasks.sourceLink })
          .from(botTasks)
          .where(
            and(
              eq(botTasks.ownerUserId, owner),
              eq(botTasks.agentId, agentId),
              isNull(botTasks.resolvedAt),
            ),
          )
          .orderBy(desc(botTasks.createdAt))
          .limit(50),
      ]);
      return {
        open: open.map(({ id, title, sourceLink }) => ({
          id,
          title,
          sourceLink,
        })),
        tasks,
        hidden: hidden.map(({ title, sourceLink, sourceApp }) => ({
          title,
          sourceLink,
          sourceApp,
        })),
        started: started.map(({ title }) => ({ title })),
      };
    },
    /**
     * A check-in clearing one of its Bot's open items as no longer needed. Only an open item of this
     * setting: a Bot cannot clear another Bot's, another person's, or one the person already decided.
     */
    async clearSuggestion(
      settingId: string,
      id: string,
    ): Promise<ProactiveSuggestion | null> {
      const [row] = await database
        .update(proactiveSuggestions)
        .set({ status: "superseded", resolvedAt: new Date() })
        .where(
          and(
            eq(proactiveSuggestions.settingId, settingId),
            eq(proactiveSuggestions.id, id),
            eq(proactiveSuggestions.status, "open"),
          ),
        )
        .returning();
      return row ?? null;
    },
    /** Whether this person turned check-ins off for all their Bots. */
    async personOff(owner: string): Promise<boolean> {
      const [row] = await database
        .select({
          off: sql<boolean>`${users.preferences}->>'proactive' = 'off'`,
        })
        .from(users)
        .where(eq(users.id, owner))
        .limit(1);
      return row?.off === true;
    },
    /** Whether this person paused this Bot. */
    async paused(owner: string, agentId: string): Promise<boolean> {
      const [row] = await database
        .select({ pausedAt: botLifecycle.pausedAt })
        .from(botLifecycle)
        .where(
          and(
            eq(botLifecycle.ownerUserId, owner),
            eq(botLifecycle.agentId, agentId),
          ),
        )
        .limit(1);
      return Boolean(row?.pausedAt);
    },

    /* --------------------------------------------------------------------------------------------
     * The run ledger (`proactive_runs`).
     * ------------------------------------------------------------------------------------------ */

    /**
     * Close check-ins left running past their lease as failed: the replica running them stopped. A
     * turn is cut off at three minutes, so a row still running at ten belongs to nobody, and the one
     * running row a setting may have must not block it for ever.
     */
    async closeStaleRuns(leaseMs: number): Promise<number> {
      const closed = await database
        .update(proactiveRuns)
        .set({
          outcome: "failed",
          error: STOPPED_BEFORE_FINISHING,
          finishedAt: sql`now()`,
        })
        .where(
          and(
            eq(proactiveRuns.outcome, "running"),
            lte(
              proactiveRuns.startedAt,
              sql`now() - make_interval(secs => ${leaseMs / 1000})`,
            ),
          ),
        )
        .returning({ id: proactiveRuns.id });
      return closed.length;
    },
    /** A check-in a gate stopped before the model, and why. */
    async skipRun(input: {
      id: string;
      setting: Pick<ProactiveSetting, "id" | "ownerUserId" | "agentId">;
      trigger: ProactiveRunTrigger;
      reason: ProactiveSkipReason;
    }) {
      await database.insert(proactiveRuns).values({
        id: input.id,
        settingId: input.setting.id,
        ownerUserId: input.setting.ownerUserId,
        agentId: input.setting.agentId,
        trigger: input.trigger,
        outcome: "skipped",
        skipReason: input.reason,
        finishedAt: sql`now()`,
      });
    },
    /**
     * Start a check-in: its `running` row. False when another is already running for this setting,
     * on any replica, which the partial unique index decides.
     */
    async beginRun(input: {
      id: string;
      setting: Pick<ProactiveSetting, "id" | "ownerUserId" | "agentId">;
      trigger: ProactiveRunTrigger;
      threadId: string;
    }): Promise<boolean> {
      try {
        await database.insert(proactiveRuns).values({
          id: input.id,
          settingId: input.setting.id,
          ownerUserId: input.setting.ownerUserId,
          agentId: input.setting.agentId,
          trigger: input.trigger,
          threadId: input.threadId,
        });
        return true;
      } catch (error) {
        if (violates(error, "proactive_runs_one_running_idx")) return false;
        throw error;
      }
    },
    /** End a running check-in. A row the lease sweep already closed stays as it was closed. */
    async finishRun(
      id: string,
      result: {
        outcome: "quiet" | "raised" | "failed";
        itemsRaised: number;
        reads: number;
        error?: string | null;
      },
    ) {
      await database
        .update(proactiveRuns)
        .set({
          outcome: result.outcome,
          itemsRaised: result.itemsRaised,
          reads: result.reads,
          error: result.error?.slice(0, 500) ?? null,
          finishedAt: sql`now()`,
        })
        .where(
          and(eq(proactiveRuns.id, id), eq(proactiveRuns.outcome, "running")),
        );
    },
    /** The setting's last check-in that reached the model and ended: where the next one's window opens. */
    async lastCheckIn(settingId: string): Promise<LastCheckIn | null> {
      const [row] = await database
        .select({
          outcome: proactiveRuns.outcome,
          startedAt: proactiveRuns.startedAt,
        })
        .from(proactiveRuns)
        .where(
          and(
            eq(proactiveRuns.settingId, settingId),
            inArray(proactiveRuns.outcome, ["quiet", "raised", "failed"]),
          ),
        )
        .orderBy(desc(proactiveRuns.startedAt))
        .limit(1);
      return row ? (row as LastCheckIn) : null;
    },
    /** The setting's newest check-in of any outcome, skipped and running ones included. */
    async latestRun(settingId: string): Promise<ProactiveRunRow | null> {
      const [row] = await database
        .select()
        .from(proactiveRuns)
        .where(eq(proactiveRuns.settingId, settingId))
        .orderBy(desc(proactiveRuns.startedAt))
        .limit(1);
      return row ?? null;
    },
    /**
     * Each of this person's settings' newest check-in, by setting: what their Bots' check-ins say
     * happened last, a skip and its reason included.
     */
    async latestRuns(owner: string): Promise<Map<string, ProactiveRunRow>> {
      const rows = await database
        .selectDistinctOn([proactiveRuns.settingId])
        .from(proactiveRuns)
        .where(eq(proactiveRuns.ownerUserId, owner))
        .orderBy(proactiveRuns.settingId, desc(proactiveRuns.startedAt));
      return new Map(rows.map((row) => [row.settingId, row]));
    },
    /** Whether a check-in for this setting is on the queue and has not been run yet. */
    async runQueued(settingId: string): Promise<boolean> {
      const [row] = await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_RUN_KIND),
            isNull(workItems.finishedAt),
            sql`${workItems.payload}->>'settingId' = ${settingId}`,
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    /** Check-ins this setting ran in the last day, for the daily cap. Skipped ones cost nothing. */
    async runsToday(settingId: string): Promise<number> {
      const [row] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(proactiveRuns)
        .where(
          and(
            eq(proactiveRuns.settingId, settingId),
            ne(proactiveRuns.outcome, "skipped"),
            gte(proactiveRuns.startedAt, sql`now() - interval '24 hours'`),
          ),
        );
      return row?.count ?? 0;
    },
    /**
     * Drop what the ledger no longer needs, older than `days`, in batches: finished check-ins, and
     * pings no open item still names. An open item's ping is what keeps it from being pinged again,
     * so that ping stays as long as the item does, and so does each person's newest ping, which the
     * app notifies on. Returns how many of each went.
     */
    async prune(
      days = PROACTIVE_LEDGER_DAYS,
    ): Promise<{ runs: number; pings: number }> {
      const cutoff = sql`now() - make_interval(days => ${days})`;
      const batches = async (remove: () => Promise<{ id: string }[]>) => {
        let removed = 0;
        for (let batch = 0; batch < PRUNE_BATCHES; batch += 1) {
          const rows = await remove();
          removed += rows.length;
          if (rows.length < PRUNE_BATCH) break;
        }
        return removed;
      };
      const runs = await batches(() =>
        database
          .delete(proactiveRuns)
          .where(
            inArray(
              proactiveRuns.id,
              database
                .select({ id: proactiveRuns.id })
                .from(proactiveRuns)
                .where(
                  and(
                    ne(proactiveRuns.outcome, "running"),
                    lte(proactiveRuns.startedAt, cutoff),
                  ),
                )
                .limit(PRUNE_BATCH),
            ),
          )
          .returning({ id: proactiveRuns.id }),
      );
      const pings = await batches(() =>
        database
          .delete(proactivePings)
          .where(
            inArray(
              proactivePings.id,
              database
                .select({ id: proactivePings.id })
                .from(proactivePings)
                .where(
                  and(
                    lte(proactivePings.createdAt, cutoff),
                    sql`not exists (select 1 from ${proactiveSuggestions} where ${proactiveSuggestions.pingId} = ${proactivePings.id} and ${proactiveSuggestions.status} = 'open')`,
                    sql`exists (select 1 from ${proactivePings} as newer where newer.owner_user_id = ${proactivePings.ownerUserId} and newer.created_at > ${proactivePings.createdAt})`,
                  ),
                )
                .limit(PRUNE_BATCH),
            ),
          )
          .returning({ id: proactivePings.id }),
      );
      return { runs, pings };
    },
    /** A setting's recent check-ins, newest first, skipped ones included. */
    async runs(settingId: string): Promise<ProactiveRunRow[]> {
      return database
        .select()
        .from(proactiveRuns)
        .where(eq(proactiveRuns.settingId, settingId))
        .orderBy(desc(proactiveRuns.startedAt))
        .limit(50);
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
    /**
     * Back to open, after a Start whose task could not be opened, so the person can press it again.
     * Left started when the Bot raised the same thing again meanwhile: that new item is the open one.
     */
    async reopenSuggestion(owner: string, id: string) {
      try {
        await database
          .update(proactiveSuggestions)
          .set({ status: "open", resolvedAt: null })
          .where(
            and(
              eq(proactiveSuggestions.ownerUserId, owner),
              eq(proactiveSuggestions.id, id),
              eq(proactiveSuggestions.status, "started"),
            ),
          );
      } catch (error) {
        if (!violates(error, "proactive_suggestions_open_dedupe_idx"))
          throw error;
      }
    },
  };
}
export type ProactiveStore = ReturnType<typeof createProactiveStore>;
