/**
 * Routines, their run history and their webhook triggers, as the rest of the product sees them.
 *
 * Everything that writes a routine writes an audit row through here, for the same reason every
 * computer action does: a routine is a standing grant of work to a Bot that nobody will be watching
 * carry it out, so who created it, who changed it and who deleted it are exactly the questions
 * somebody asks afterwards. The trail is the thing the change goes through, not a report written
 * beside it.
 *
 * Two shapes of writing that look similar and are not. A run is claimed, which can fail because
 * another run of the same routine is already in flight; the database decides that with a unique
 * index and this returns null rather than pretending. A delivery is counted, which cannot fail and
 * must not stop the work if it does.
 */
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { routineRuns, routines, webhookTriggers } from "../db/schema";
import {
  type RoutineSchedule,
  nextDueAt,
  parseRoutineSchedule,
} from "./schedule";
import { mintEndpointId, mintWebhookSecret } from "./webhooks";

export type RoutineTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "missed";

export type RoutineRunRecord = {
  id: string;
  routineId: string;
  trigger: RoutineTrigger;
  status: RoutineRunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
  threadId: string | null;
};

export type RoutineRecord = {
  id: string;
  agentId: string;
  ownerUserId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * When it is next expected to act, or null for a schedule that will never call again.
   *
   * Computed on read rather than stored. A stored next-due is a value that is wrong the moment
   * somebody edits the schedule or the process is down when it passes, and a list that quietly shows
   * a time that already went by is worse than one that recomputes.
   */
  nextDueAt: string | null;
  lastRun: RoutineRunRecord | null;
};

/** What the surfaces are allowed to see. The secret hash is not on it, and never leaves this file. */
export type WebhookTriggerRecord = {
  id: string;
  endpointId: string;
  name: string;
  ownerUserId: string;
  routineId: string | null;
  agentId: string | null;
  prompt: string | null;
  enabled: boolean;
  verificationPending: boolean;
  verifiedAt: string | null;
  sample: Record<string, unknown> | null;
  eventTypes: string[];
  deliveryCount: number;
  lastReceivedAt: string | null;
  createdAt: string;
};

/** The receiver's view: the same trigger, plus the one field it needs and nobody else may have. */
export type WebhookTriggerWithSecret = WebhookTriggerRecord & {
  secretHash: string;
};

export type CreateRoutineInput = {
  agentId: string;
  ownerUserId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
};

export type UpdateRoutineInput = {
  name?: string;
  prompt?: string;
  schedule?: RoutineSchedule;
  enabled?: boolean;
};

export type CreateWebhookTriggerInput = {
  name: string;
  ownerUserId: string;
  /** Either this, reusing a routine… */
  routineId?: string;
  /** …or these two, carrying work of their own. The route decides; this stores what it decided. */
  agentId?: string;
  prompt?: string;
  eventTypes?: string[];
};

/**
 * A routine the scheduler might act on, with the two facts the decision needs.
 *
 * `activeRun` is separate from `lastRunAt` because they answer different questions: one is "has this
 * window been taken", the other is "is one still going". A long run that overruns its next window
 * must not be joined by a second, and a routine whose last run finished hours ago is free.
 */
export type DueCandidate = {
  id: string;
  agentId: string;
  ownerUserId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule | null;
  lastRunAt: Date | null;
  activeRun: boolean;
};

export type RoutineStore = ReturnType<typeof createRoutineStore>;

export function createRoutineStore(
  database: Database,
  /** Absent is not offered. A routine nobody can account for is not a routine worth having. */
  auditStore: AuditStore,
) {
  /**
   * The most recent run of each routine, in one query rather than one per row.
   *
   * Every run of the listed routines is read and the newest of each is kept here, rather than
   * issuing a query per routine on a page whose entire job is to list routines. The
   * (routine_id, started_at) index serves the ordering, so the database does the sorting and this
   * walks the result once.
   */
  async function latestRuns(routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunRecord>();
    const rows = await database
      .select()
      .from(routineRuns)
      .where(inArray(routineRuns.routineId, routineIds))
      .orderBy(routineRuns.routineId, desc(routineRuns.startedAt));

    const latest = new Map<string, RoutineRunRecord>();
    for (const row of rows) {
      if (!latest.has(row.routineId)) latest.set(row.routineId, asRun(row));
    }
    return latest;
  }

  async function decorate(
    rows: (typeof routines.$inferSelect)[],
    now: Date,
  ): Promise<RoutineRecord[]> {
    const latest = await latestRuns(rows.map((row) => row.id));
    return rows.map((row) => {
      const schedule = parseRoutineSchedule(row.schedule);
      const lastRun = latest.get(row.id) ?? null;
      return {
        id: row.id,
        agentId: row.agentId,
        ownerUserId: row.ownerUserId,
        name: row.name,
        prompt: row.prompt,
        // A schedule that will not parse is shown as a `once` in the past rather than crashing the
        // page. It cannot fire, the scheduler skips it for the same reason, and the person can see
        // the routine in order to fix or delete it, which they cannot do if the list refuses to load.
        schedule: schedule ?? { type: "once", at: new Date(0).toISOString() },
        enabled: row.enabled,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        nextDueAt:
          schedule && row.enabled
            ? (nextDueAt(schedule, {
                now,
                lastRunAt: lastRun ? new Date(lastRun.startedAt) : null,
              })?.toISOString() ?? null)
            : null,
        lastRun,
      };
    });
  }

  return {
    /** Everything one person owns. Somebody else's routine is never read into the process at all. */
    list: async (
      ownerUserId: string,
      now: Date = new Date(),
    ): Promise<RoutineRecord[]> => {
      const rows = await database
        .select()
        .from(routines)
        .where(eq(routines.ownerUserId, ownerUserId))
        .orderBy(desc(routines.createdAt));
      return decorate(rows, now);
    },

    /**
     * One routine, and only for the person who owns it.
     *
     * The owner is part of the query rather than checked afterwards. "We fetched it and then decided
     * not to show it" is the shape most accidental disclosures take, and a routine carries a prompt
     * somebody wrote about their own work.
     */
    get: async (
      id: string,
      ownerUserId: string,
      now: Date = new Date(),
    ): Promise<RoutineRecord | null> => {
      const rows = await database
        .select()
        .from(routines)
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .limit(1);
      return (await decorate(rows, now))[0] ?? null;
    },

    create: async (
      input: CreateRoutineInput,
      actor: { id: string; userId?: string },
    ): Promise<RoutineRecord> => {
      const [row] = await database
        .insert(routines)
        .values({
          agentId: input.agentId,
          ownerUserId: input.ownerUserId,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule as unknown as Record<string, unknown>,
          enabled: input.enabled ?? true,
        })
        .returning();
      if (!row) throw new Error("The routine could not be created.");

      await writeRoutineEvent(auditStore, "routine.created", row, actor);
      return (await decorate([row], new Date()))[0] as RoutineRecord;
    },

    update: async (
      id: string,
      ownerUserId: string,
      patch: UpdateRoutineInput,
      actor: { id: string; userId?: string },
    ): Promise<RoutineRecord | null> => {
      const [row] = await database
        .update(routines)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.schedule !== undefined
            ? {
                schedule: patch.schedule as unknown as Record<string, unknown>,
              }
            : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .returning();
      if (!row) return null;

      await writeRoutineEvent(auditStore, "routine.updated", row, actor);
      return (await decorate([row], new Date()))[0] as RoutineRecord;
    },

    remove: async (
      id: string,
      ownerUserId: string,
      actor: { id: string; userId?: string },
    ): Promise<boolean> => {
      const [row] = await database
        .delete(routines)
        .where(and(eq(routines.id, id), eq(routines.ownerUserId, ownerUserId)))
        .returning();
      if (!row) return false;
      await writeRoutineEvent(auditStore, "routine.deleted", row, actor);
      return true;
    },

    runs: async (
      routineId: string,
      limit = 25,
    ): Promise<RoutineRunRecord[]> => {
      const rows = await database
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, routineId))
        .orderBy(desc(routineRuns.startedAt))
        .limit(limit);
      return rows.map(asRun);
    },

    /**
     * Take the next run of this routine, or find that somebody else already has.
     *
     * Null is an ordinary answer, not an error. Two ticks overlapping and a person pressing Run now
     * while the schedule fires are both normal, and both must end with one run rather than two. The
     * unique index decides it; this reads the rejection and reports that the routine is busy.
     */
    startRun: async (input: {
      routineId: string;
      trigger: RoutineTrigger;
      threadId: string;
      /** For a missed window, the moment it should have run. Now, for everything else. */
      startedAt?: Date;
      actor: { id: string; userId?: string };
    }): Promise<RoutineRunRecord | null> => {
      let row: typeof routineRuns.$inferSelect | undefined;
      try {
        [row] = await database
          .insert(routineRuns)
          .values({
            routineId: input.routineId,
            trigger: input.trigger,
            status: "running",
            threadId: input.threadId,
            ...(input.startedAt ? { startedAt: input.startedAt } : {}),
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
      if (!row) return null;

      await recordAuditEvent(auditStore, {
        eventType: "routine.run_started",
        targetType: "routine",
        targetId: input.routineId,
        ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
        payload: {
          actor: input.actor.id,
          run: row.id,
          trigger: input.trigger,
          thread: input.threadId,
        },
      });
      return asRun(row);
    },

    /**
     * Close a run out.
     *
     * Tolerates the row having gone. A routine deleted while one of its runs is in flight takes the
     * run row with it, and the runner finishing a moment later must not turn that into an unhandled
     * failure: the person got what they asked for, which was the routine gone.
     */
    finishRun: async (input: {
      runId: string;
      routineId: string;
      status: Extract<RoutineRunStatus, "completed" | "failed">;
      summary?: string;
      error?: string;
      actor: { id: string; userId?: string };
    }): Promise<void> => {
      await database
        .update(routineRuns)
        .set({
          status: input.status,
          finishedAt: new Date(),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        })
        .where(eq(routineRuns.id, input.runId));

      await recordAuditEvent(auditStore, {
        eventType:
          input.status === "failed"
            ? "routine.run_failed"
            : "routine.run_finished",
        targetType: "routine",
        targetId: input.routineId,
        ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
        payload: {
          actor: input.actor.id,
          run: input.runId,
          ...(input.error ? { failure: input.error } : {}),
        },
      });
    },

    /**
     * Record a window that came and went with nobody awake for it.
     *
     * Stamped with the window's own time rather than with now. That makes it idempotent: the next
     * tick sees a run at or after the window and decides there is nothing to do, instead of writing
     * the same miss again once a minute until the following window comes round.
     */
    recordMissed: async (input: {
      routineId: string;
      dueAt: Date;
      actor: { id: string; userId?: string };
    }): Promise<void> => {
      const [row] = await database
        .insert(routineRuns)
        .values({
          routineId: input.routineId,
          trigger: "schedule",
          status: "missed",
          startedAt: input.dueAt,
          finishedAt: new Date(),
          summary:
            "This deployment was not running when the routine was due, so it did not happen.",
        })
        .returning();

      await recordAuditEvent(auditStore, {
        eventType: "routine.run_missed",
        targetType: "routine",
        targetId: input.routineId,
        ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
        payload: {
          actor: input.actor.id,
          ...(row ? { run: row.id } : {}),
          due: input.dueAt.toISOString(),
        },
      });
    },

    /**
     * Every enabled routine, with what the scheduler needs to decide about it.
     *
     * All of them, every tick, rather than a query that tries to select the due ones in SQL. What
     * "due" means is weekday sets and grace windows, and expressing that twice, once in schedule.ts
     * and once in a WHERE clause, guarantees the two disagree the first time either is changed.
     */
    dueCandidates: async (): Promise<DueCandidate[]> => {
      const rows = await database
        .select()
        .from(routines)
        .where(eq(routines.enabled, true));
      if (rows.length === 0) return [];

      /*
       * The two facts, aggregated by the database rather than by reading every run.
       *
       * A grouped query rather than a correlated subquery per routine, because the run history of a
       * daily routine grows by one row a day forever and a tick that reads all of them is a tick
       * that gets slower every week this deployment stays up.
       */
      const summary = await database
        .select({
          routineId: routineRuns.routineId,
          lastRunAt: max(routineRuns.startedAt),
          activeRun: sql<boolean>`bool_or(${routineRuns.status} in ('queued', 'running'))`,
        })
        .from(routineRuns)
        .where(
          inArray(
            routineRuns.routineId,
            rows.map((row) => row.id),
          ),
        )
        .groupBy(routineRuns.routineId);

      const byRoutine = new Map(
        summary.map((entry) => [entry.routineId, entry] as const),
      );

      return rows.map((row) => {
        const runs = byRoutine.get(row.id);
        return {
          id: row.id,
          agentId: row.agentId,
          ownerUserId: row.ownerUserId,
          name: row.name,
          prompt: row.prompt,
          schedule: parseRoutineSchedule(row.schedule),
          lastRunAt: runs?.lastRunAt ? new Date(runs.lastRunAt) : null,
          activeRun: runs?.activeRun === true,
        };
      });
    },

    /**
     * One routine in the shape the scheduler works in.
     *
     * Not scoped to an owner, because the two callers are the scheduler and a delivery from another
     * system, and neither is a person. Whoever hands a routine id to this has already established
     * that they are entitled to it: the routes do it with an ownership check before they call, and
     * the receiver does it with a secret.
     */
    candidate: async (id: string): Promise<DueCandidate | null> => {
      const [row] = await database
        .select()
        .from(routines)
        .where(eq(routines.id, id))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        agentId: row.agentId,
        ownerUserId: row.ownerUserId,
        name: row.name,
        prompt: row.prompt,
        schedule: parseRoutineSchedule(row.schedule),
        lastRunAt: null,
        activeRun: false,
      };
    },

    listTriggers: async (
      ownerUserId: string,
    ): Promise<WebhookTriggerRecord[]> => {
      const rows = await database
        .select()
        .from(webhookTriggers)
        .where(eq(webhookTriggers.ownerUserId, ownerUserId))
        .orderBy(desc(webhookTriggers.createdAt));
      return rows.map(asTrigger);
    },

    /**
     * Create a trigger and hand back its secret, once.
     *
     * The secret is in the return value and nowhere else. It is not written to the audit payload, not
     * logged, and cannot be read back: the row keeps a SHA-256 of it, which is enough to check a
     * delivery and not enough to make one.
     */
    createTrigger: async (
      input: CreateWebhookTriggerInput,
      actor: { id: string; userId?: string },
    ): Promise<{ trigger: WebhookTriggerRecord; secret: string }> => {
      const minted = mintWebhookSecret();
      const [row] = await database
        .insert(webhookTriggers)
        .values({
          endpointId: mintEndpointId(),
          name: input.name,
          ownerUserId: input.ownerUserId,
          routineId: input.routineId ?? null,
          agentId: input.agentId ?? null,
          prompt: input.prompt ?? null,
          secretHash: minted.hash,
          eventTypes: input.eventTypes ?? [],
        })
        .returning();
      if (!row) throw new Error("The trigger could not be created.");

      await recordAuditEvent(auditStore, {
        eventType: "webhook.trigger_created",
        targetType: "webhook_trigger",
        targetId: row.id,
        ...(actor.userId ? { actorUserId: actor.userId } : {}),
        payload: {
          actor: actor.id,
          name: row.name,
          endpoint: row.endpointId,
          runs: row.routineId
            ? `routine ${row.routineId}`
            : `bot ${row.agentId}`,
          eventTypes: row.eventTypes,
        },
      });
      return { trigger: asTrigger(row), secret: minted.secret };
    },

    /**
     * A new secret for an existing trigger.
     *
     * The old one stops working the instant this returns, with no overlap. An overlap window is the
     * usual kindness for a rotating credential and it is the wrong call here: the reason somebody
     * rotates a webhook secret is that they think the old one leaked, and a grace period is a
     * grace period for whoever has it.
     */
    rotateTriggerSecret: async (
      id: string,
      ownerUserId: string,
      actor: { id: string; userId?: string },
    ): Promise<{ trigger: WebhookTriggerRecord; secret: string } | null> => {
      const minted = mintWebhookSecret();
      const [row] = await database
        .update(webhookTriggers)
        .set({ secretHash: minted.hash, updatedAt: new Date() })
        .where(
          and(
            eq(webhookTriggers.id, id),
            eq(webhookTriggers.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      if (!row) return null;

      await recordAuditEvent(auditStore, {
        eventType: "webhook.trigger_rotated",
        targetType: "webhook_trigger",
        targetId: row.id,
        ...(actor.userId ? { actorUserId: actor.userId } : {}),
        payload: {
          actor: actor.id,
          name: row.name,
          endpoint: row.endpointId,
          note: "The previous secret stopped working immediately.",
        },
      });
      return { trigger: asTrigger(row), secret: minted.secret };
    },

    updateTrigger: async (
      id: string,
      ownerUserId: string,
      patch: { enabled?: boolean; eventTypes?: string[] },
    ): Promise<WebhookTriggerRecord | null> => {
      const [row] = await database
        .update(webhookTriggers)
        .set({
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.eventTypes !== undefined
            ? { eventTypes: patch.eventTypes }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(webhookTriggers.id, id),
            eq(webhookTriggers.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      return row ? asTrigger(row) : null;
    },

    /**
     * Confirm a captured sample, so this trigger starts doing work.
     *
     * Refused unless a sample has actually arrived. Confirming a trigger nothing has ever called is
     * confirming nothing, and it would turn the one gate that catches a misdirected hook into a
     * checkbox somebody ticks on the way past.
     */
    verifyTrigger: async (
      id: string,
      ownerUserId: string,
    ): Promise<WebhookTriggerRecord | null> => {
      const [row] = await database
        .update(webhookTriggers)
        .set({
          verificationPending: false,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(webhookTriggers.id, id),
            eq(webhookTriggers.ownerUserId, ownerUserId),
            sql`${webhookTriggers.sample} is not null`,
          ),
        )
        .returning();
      return row ? asTrigger(row) : null;
    },

    deleteTrigger: async (
      id: string,
      ownerUserId: string,
    ): Promise<boolean> => {
      const [row] = await database
        .delete(webhookTriggers)
        .where(
          and(
            eq(webhookTriggers.id, id),
            eq(webhookTriggers.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      return Boolean(row);
    },

    /** The receiver's lookup. Carries the hash, which is why it is not the shape the routes return. */
    triggerByEndpoint: async (
      endpointId: string,
    ): Promise<WebhookTriggerWithSecret | null> => {
      const [row] = await database
        .select()
        .from(webhookTriggers)
        .where(eq(webhookTriggers.endpointId, endpointId))
        .limit(1);
      return row ? { ...asTrigger(row), secretHash: row.secretHash } : null;
    },

    /**
     * Note that a delivery arrived, and keep the first one.
     *
     * The sample is written only while verification is pending, so a trigger in use does not
     * accumulate somebody else's payloads in this deployment's database. What it keeps afterwards is
     * a count and a timestamp, which is enough to answer "is this thing actually being called".
     */
    recordDelivery: async (input: {
      id: string;
      body: unknown;
      captureSample: boolean;
    }): Promise<void> => {
      await database
        .update(webhookTriggers)
        .set({
          deliveryCount: sql`${webhookTriggers.deliveryCount} + 1`,
          lastReceivedAt: new Date(),
          ...(input.captureSample ? { sample: asSample(input.body) } : {}),
        })
        .where(eq(webhookTriggers.id, input.id));
    },

    /** One row for a delivery that was answered, whichever way it was answered. */
    recordDeliveryEvent: async (input: {
      endpointId: string;
      triggerId?: string;
      accepted: boolean;
      reason: string;
      eventType: string | null;
    }): Promise<void> => {
      await recordAuditEvent(auditStore, {
        eventType: input.accepted ? "webhook.received" : "webhook.rejected",
        targetType: "webhook_trigger",
        targetId: input.triggerId ?? input.endpointId,
        payload: {
          endpoint: input.endpointId,
          reason: input.reason,
          ...(input.eventType ? { event: input.eventType } : {}),
        },
      });
    },
  };
}

/**
 * One row for a change somebody made to a routine.
 *
 * The prompt is not in the payload. It is the instruction a person wrote about their own work, it
 * can name customers, systems and amounts, and `audit.ts` would redact a key called `prompt` anyway,
 * so putting it there would only mean having placed it somewhere it had to be caught on the way
 * past. The name, the Bot and the schedule are what a reader needs.
 */
async function writeRoutineEvent(
  auditStore: AuditStore,
  eventType: "routine.created" | "routine.updated" | "routine.deleted",
  row: typeof routines.$inferSelect,
  actor: { id: string; userId?: string },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "routine",
    targetId: row.id,
    ...(actor.userId ? { actorUserId: actor.userId } : {}),
    payload: {
      actor: actor.id,
      name: row.name,
      bot: row.agentId,
      schedule: row.schedule,
      enabled: row.enabled,
    },
  });
}

function asRun(row: typeof routineRuns.$inferSelect): RoutineRunRecord {
  return {
    id: row.id,
    routineId: row.routineId,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    summary: row.summary,
    error: row.error,
    threadId: row.threadId,
  };
}

function asTrigger(
  row: typeof webhookTriggers.$inferSelect,
): WebhookTriggerRecord {
  return {
    id: row.id,
    endpointId: row.endpointId,
    name: row.name,
    ownerUserId: row.ownerUserId,
    routineId: row.routineId,
    agentId: row.agentId,
    prompt: row.prompt,
    enabled: row.enabled,
    verificationPending: row.verificationPending,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    sample: row.sample,
    eventTypes: [...row.eventTypes],
    deliveryCount: row.deliveryCount,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A delivery, in the shape a `jsonb` column takes.
 *
 * A body that is an array or a bare string is wrapped rather than rejected. The column holds an
 * object, and a sample nobody can look at because the payload was a JSON array is a sample that
 * defeats the point of capturing one.
 */
function asSample(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : { body: body ?? null };
}

/**
 * Whether the database refused a write because something equivalent already existed.
 *
 * Matched on PostgreSQL's own SQLSTATE rather than on the message, which is localised and rephrased
 * between versions. Bun's driver puts the SQLSTATE in `errno` and its own name in `code`, which is
 * the opposite of what most Postgres clients do, so both are read and any wrapping cause is read
 * too. Anything this cannot positively identify as a duplicate is rethrown: a claim that failed for
 * a reason nobody understood must not be reported as "another run has it".
 */
function isUniqueViolation(error: unknown): boolean {
  const UNIQUE_VIOLATION = "23505";
  const matches = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const fields = value as { code?: unknown; errno?: unknown };
    return (
      String(fields.code) === UNIQUE_VIOLATION ||
      String(fields.errno) === UNIQUE_VIOLATION
    );
  };
  return (
    matches(error) || matches(error instanceof Error ? error.cause : undefined)
  );
}
