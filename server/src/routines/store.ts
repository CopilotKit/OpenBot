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
import { and, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
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
  /**
   * When the routine came into existence.
   *
   * Carried because a window before this moment is not a window this routine had. Without it the
   * first tick after somebody writes "every weekday at eight" at three in the afternoon records a
   * run that says the deployment was asleep at eight, which is false and is the one thing the
   * missed row exists to be trusted about. See decideScheduleAction.
   */
  createdAt: Date;
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
   * The most recent run of each routine, one row per routine.
   *
   * `distinct on` rather than reading every run and keeping the first of each in JavaScript. The
   * difference is the whole life of a deployment: the run history of a daily routine grows by one
   * row a day forever, this backs the routines page, and the page refetches every fifteen seconds
   * while somebody has it open. Reading all of it would mean ten routines and two years costing
   * seven thousand rows fetched and discarded to produce ten values, and getting worse every week.
   *
   * The (routine_id, started_at) index is what makes it cheap: the ordering this asks for is the
   * order the index is already in, so the database walks to the newest of each and stops.
   */
  async function latestRuns(routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunRecord>();
    const rows = await database
      .selectDistinctOn([routineRuns.routineId])
      .from(routineRuns)
      .where(inArray(routineRuns.routineId, routineIds))
      .orderBy(routineRuns.routineId, desc(routineRuns.startedAt));

    return new Map(rows.map((row) => [row.routineId, asRun(row)] as const));
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
     * Close out runs that nothing is coming back for.
     *
     * A run row is claimed before the work starts and closed when it ends, which leaves one shape of
     * row nothing else in this file can clear: the process that owned the run died between the two.
     * A killed container, a machine that lost power, a deploy that rolled while a Bot was browsing.
     * The row stays `running` forever, it holds the one-live-run index, and the routine never fires
     * again — not from the clock, not from Run now, not from a delivery — with nothing on the page
     * to say why and no way to fix it short of deleting the routine and its whole history.
     *
     * So the next process to tick puts them down. `startedBefore` is what makes that safe: a ceiling
     * comfortably longer than any run the runner will allow means anything older than it belongs to
     * a process that is not alive to finish it. A shorter one would be this deployment shooting its
     * own healthy long runs.
     *
     * Recorded as failed rather than deleted, and the error says what is actually known, which is
     * that how the run ended is not known. A run that vanished from the history would leave the
     * person who reads it believing nothing was started, and something was.
     */
    reapStaleRuns: async (input: {
      startedBefore: Date;
      actor: { id: string; userId?: string };
    }): Promise<number> => {
      const rows = await database
        .update(routineRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error:
            "This deployment stopped while the run was going, so how it ended is not known. The run was closed out so the routine can run again.",
        })
        .where(
          and(
            inArray(routineRuns.status, ["queued", "running"]),
            lt(routineRuns.startedAt, input.startedBefore),
          ),
        )
        .returning();

      for (const row of rows) {
        await recordAuditEvent(auditStore, {
          eventType: "routine.run_failed",
          targetType: "routine",
          targetId: row.routineId,
          ...(input.actor.userId ? { actorUserId: input.actor.userId } : {}),
          payload: {
            actor: input.actor.id,
            run: row.id,
            failure: row.error,
            started: row.startedAt.toISOString(),
          },
        });
      }
      return rows.length;
    },

    /**
     * Record a window that came and went with nobody awake for it.
     *
     * Stamped with the window's own time rather than with now. That makes it idempotent: the next
     * tick sees a run at or after the window and decides there is nothing to do, instead of writing
     * the same miss again once a minute until the following window comes round.
     *
     * One row per gap, not one per window in it. `lastOccurrenceOnOrBefore` returns only the most
     * recent occurrence, so a laptop shut for a week records a miss for Friday and says nothing
     * about Monday to Thursday. That is the deliberate choice: the fact somebody needs is that the
     * routine has not been running, and four more rows saying the same thing on four consecutive
     * mornings would bury it rather than sharpen it.
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
          createdAt: row.createdAt,
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
        createdAt: row.createdAt,
        lastRunAt: null,
        activeRun: false,
      };
    },

    /**
     * Every trigger in this deployment, not one person's.
     *
     * Deliberately not scoped the way routines are, and the difference is what a trigger is. A
     * routine is somebody's own work and nobody else's business. A trigger is a URL on the public
     * internet that sets a Bot working, which is a fact about the deployment rather than about the
     * person who happened to create it, and the question an administrator opens this page to ask is
     * "what is reachable from outside here" — a question a per-person list answers wrongly and
     * confidently. An administrator who could see only their own triggers could not shut a door
     * somebody else opened, which is exactly the moment somebody needs to.
     *
     * The routes are what keep this away from everybody else: the whole trigger surface requires an
     * administrator. See routines/routes.ts.
     */
    listTriggers: async (): Promise<WebhookTriggerRecord[]> => {
      const rows = await database
        .select()
        .from(webhookTriggers)
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
      actor: { id: string; userId?: string },
    ): Promise<{ trigger: WebhookTriggerRecord; secret: string } | null> => {
      const minted = mintWebhookSecret();
      const [row] = await database
        .update(webhookTriggers)
        .set({ secretHash: minted.hash, updatedAt: new Date() })
        .where(eq(webhookTriggers.id, id))
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

    /**
     * Narrow a trigger, or switch it off.
     *
     * Recorded, unlike most edits in this product, because both things this can do are things a
     * public endpoint stops accepting: an administrator who finds that deliveries stopped last
     * Tuesday is owed the row that says who did it and when, and "somebody turned it off" is not an
     * answer a database can give afterwards from the row alone.
     */
    updateTrigger: async (
      id: string,
      patch: { enabled?: boolean; eventTypes?: string[] },
      actor: { id: string; userId?: string },
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
        .where(eq(webhookTriggers.id, id))
        .returning();
      if (!row) return null;

      await recordAuditEvent(auditStore, {
        eventType: "webhook.trigger_updated",
        targetType: "webhook_trigger",
        targetId: row.id,
        ...(actor.userId ? { actorUserId: actor.userId } : {}),
        payload: {
          actor: actor.id,
          name: row.name,
          endpoint: row.endpointId,
          enabled: row.enabled,
          eventTypes: row.eventTypes,
        },
      });
      return asTrigger(row);
    },

    /**
     * Confirm a captured sample, so this trigger starts doing work.
     *
     * Refused unless a sample has actually arrived. Confirming a trigger nothing has ever called is
     * confirming nothing, and it would turn the one gate that catches a misdirected hook into a
     * checkbox somebody ticks on the way past.
     *
     * The row it leaves is the most important one in this file. Every delivery before this point ran
     * nothing; every delivery after it sets a Bot working on somebody's live systems, and the trail
     * has to be able to say who moved the endpoint from one state to the other.
     */
    verifyTrigger: async (
      id: string,
      actor: { id: string; userId?: string },
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
            sql`${webhookTriggers.sample} is not null`,
          ),
        )
        .returning();
      if (!row) return null;

      await recordAuditEvent(auditStore, {
        eventType: "webhook.trigger_verified",
        targetType: "webhook_trigger",
        targetId: row.id,
        ...(actor.userId ? { actorUserId: actor.userId } : {}),
        payload: {
          actor: actor.id,
          name: row.name,
          endpoint: row.endpointId,
          note: "Deliveries to this endpoint now run work.",
        },
      });
      return asTrigger(row);
    },

    deleteTrigger: async (
      id: string,
      actor: { id: string; userId?: string },
    ): Promise<boolean> => {
      const [row] = await database
        .delete(webhookTriggers)
        .where(eq(webhookTriggers.id, id))
        .returning();
      if (!row) return false;

      // The row outlives the trigger on purpose. A deleted endpoint is one that stops answering, and
      // the deletion is the only place that fact can be written down: the table it was in no longer
      // has anything to say about it.
      await recordAuditEvent(auditStore, {
        eventType: "webhook.trigger_deleted",
        targetType: "webhook_trigger",
        targetId: row.id,
        ...(actor.userId ? { actorUserId: actor.userId } : {}),
        payload: {
          actor: actor.id,
          name: row.name,
          endpoint: row.endpointId,
        },
      });
      return true;
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
     * Note that a delivery arrived, and keep the FIRST one.
     *
     * First, not latest, and the database is what decides that rather than the caller: the sample is
     * only ever written where there is not one already. Every delivery that arrives before somebody
     * confirms the trigger is a delivery this may be called for, and a `set` would leave the row
     * holding whichever one landed last. That is the failure the verification gate is built to
     * prevent, wearing the gate's own clothes: the person opens the page, reads the delivery that is
     * there, presses "this is right, start running it", and confirms a payload they never saw
     * because another one arrived while they were reading.
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
          ...(input.captureSample
            ? {
                // The delivery travels as a bound parameter and the column keeps the first
                // non-null, so two deliveries arriving a second apart cannot race over the sample
                // either: whichever statement runs second finds a value there and leaves it.
                sample: sql`coalesce(${webhookTriggers.sample}, ${asSample(input.body)}::jsonb)`,
              }
            : {}),
        })
        .where(eq(webhookTriggers.id, input.id));
    },

    /**
     * One row for a delivery that was answered, whichever way it was answered.
     *
     * Three outcomes rather than a boolean. A captured delivery is not a refused one: it presented
     * the right secret and was deliberately kept, and a trail that files it under "refused" answers
     * "did my sample arrive" with the word no.
     */
    recordDeliveryEvent: async (input: {
      endpointId: string;
      triggerId?: string;
      outcome: "ran" | "captured" | "refused";
      reason: string;
      eventType: string | null;
    }): Promise<void> => {
      await recordAuditEvent(auditStore, {
        eventType:
          input.outcome === "ran"
            ? "webhook.received"
            : input.outcome === "captured"
              ? "webhook.captured"
              : "webhook.rejected",
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
