/**
 * What one Bot is doing for one person, and what it needs from them.
 *
 * READ FROM THE LEDGERS THAT ALREADY EXIST, never copied into a new one: routine runs, responsibility
 * runs, the hop queue, approval requests, saved questions and follow-ups. A second ledger would
 * drift from the first the moment one of them gained a state, and Activity would then say something
 * the routines page contradicts.
 *
 * EVERY QUERY IS NARROWED TO THE PERSON FIRST. A public Bot works for many people; this screen shows
 * the work done in the caller's name and nothing of anybody else's.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { HANDOFF_KIND } from "../agents/handoff";
import { WAKE_UP_KIND, type WakeUpPayload } from "../agents/wake-up";
import type { Database } from "../db/client";
import {
  approvalRequests,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  routineRuns,
  routines,
  workItems,
} from "../db/schema";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

export type ActivityKind =
  | "routine"
  | "responsibility"
  | "handoff"
  | "approval"
  | "question"
  | "follow_up";

export type ActivityItem = {
  /** Unique within the list; for a hop or a follow-up it is also what stop/cancel takes. */
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  /** A short state a person reads: running, waiting for you, queued, succeeded, failed… */
  status: string;
  /** When it started, is due, or ended, depending on the section. ISO-8601. */
  at: string;
  /** The conversation it belongs to, when one can be named. */
  channelId: string | null;
  /** Whether this item needs the person to do something. */
  needsYou: boolean;
  /** A delegated task that can still be stopped from Activity. */
  stoppable: boolean;
  /** A follow-up that can still be cancelled. */
  cancellable: boolean;
};

export type BotActivity = {
  inProgress: ActivityItem[];
  scheduled: ActivityItem[];
  completed: ActivityItem[];
};

export type BotAttention = {
  agentId: string;
  questions: number;
  approvals: number;
  handoffs: number;
  unread: number;
};

const COMPLETED_LIMIT = 25;
const clip = (text: string | null | undefined, max = 200) =>
  text ? Array.from(text).slice(0, max).join("") : null;
const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : new Date(0).toISOString();

type HandoffPayload = {
  fromBotId?: string;
  toBotId?: string;
  actorId?: string;
  threadId?: string;
  task?: string;
  toName?: string;
  fromName?: string;
  answerIn?: string;
};

type QuestionPayload = {
  actorId?: string;
  botId?: string;
  sourceBotId?: string;
  threadId?: string;
  channelId?: string;
  question?: string;
};

export type ActivityStore = ReturnType<typeof createActivityStore>;

export function createActivityStore(database: Database) {
  /** The channel a thread is shown in, for the items that know only their thread. */
  async function channelsForThreads(
    threadIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(threadIds.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await database
      .select({
        threadId: intelligenceChannelMappings.threadId,
        channelId: intelligenceChannelMappings.channelId,
      })
      .from(intelligenceChannelMappings)
      .where(inArray(intelligenceChannelMappings.threadId, unique));
    return new Map(rows.map((row) => [row.threadId, row.channelId]));
  }

  const handoffsFor = (ownerUserId: string, agentId: string) =>
    and(
      eq(workItems.kind, HANDOFF_KIND),
      sql`${workItems.payload}->>'actorId' = ${ownerUserId}`,
      sql`(${workItems.payload}->>'fromBotId' = ${agentId} or ${workItems.payload}->>'toBotId' = ${agentId})`,
      // Forward hops only: a relay or a failure notice is the tail of a hop, not a task of its own.
      sql`${workItems.payload}->>'answerIn' is null`,
    );

  return {
    async forBot(ownerUserId: string, agentId: string): Promise<BotActivity> {
      const activity: BotActivity = {
        inProgress: [],
        scheduled: [],
        completed: [],
      };
      const now = Date.now();

      // Routines: the standing schedule, and each firing.
      const ownedRoutines = await database
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.ownerUserId, ownerUserId),
            eq(routines.agentId, agentId),
          ),
        );
      for (const routine of ownedRoutines)
        if (routine.enabled)
          activity.scheduled.push({
            id: `routine:${routine.id}`,
            kind: "routine",
            title: clip(routine.instruction, 120) ?? "Routine",
            detail: `Repeats on ${routine.cron} (${routine.timezone})`,
            status: "scheduled",
            at: iso(routine.nextRunAt),
            channelId: routine.channelId,
            needsYou: false,
            stoppable: false,
            cancellable: false,
          });
      if (ownedRoutines.length > 0) {
        const byId = new Map(
          ownedRoutines.map((routine) => [routine.id, routine]),
        );
        const runs = await database
          .select()
          .from(routineRuns)
          .where(inArray(routineRuns.routineId, [...byId.keys()]))
          .orderBy(desc(routineRuns.startedAt))
          .limit(COMPLETED_LIMIT * 2);
        for (const run of runs) {
          const routine = byId.get(run.routineId);
          if (!routine) continue;
          const item: ActivityItem = {
            id: `routine-run:${run.id}`,
            kind: "routine",
            title: clip(routine.instruction, 120) ?? "Routine",
            detail: clip(run.error),
            status: run.status ?? "running",
            at: iso(run.finishedAt ?? run.startedAt),
            channelId: routine.channelId,
            needsYou: run.status === "waiting",
            stoppable: false,
            cancellable: false,
          };
          if (run.status === null || run.status === "waiting")
            activity.inProgress.push(item);
          else activity.completed.push(item);
        }
      }

      // Responsibilities: an active one is standing work; each run is a piece of it.
      const goals = await database
        .select()
        .from(responsibilities)
        .where(
          and(
            eq(responsibilities.ownerUserId, ownerUserId),
            eq(responsibilities.agentId, agentId),
          ),
        );
      for (const goal of goals)
        if (goal.status === "active")
          activity.scheduled.push({
            id: `responsibility:${goal.id}`,
            kind: "responsibility",
            title: goal.title,
            detail: goal.subscriptions.length
              ? `Wakes on ${goal.subscriptions.map((s) => `${s.source}/${s.eventType}`).join(", ")}`
              : "Runs when asked",
            status: "active",
            at: iso(goal.updatedAt),
            channelId: goal.channelId,
            needsYou: false,
            stoppable: false,
            cancellable: false,
          });
      if (goals.length > 0) {
        const byId = new Map(goals.map((goal) => [goal.id, goal]));
        const runs = await database
          .select({
            run: responsibilityRuns,
            eventType: responsibilityEvents.type,
            source: responsibilityEvents.source,
          })
          .from(responsibilityRuns)
          .innerJoin(
            responsibilityEvents,
            eq(responsibilityEvents.id, responsibilityRuns.eventId),
          )
          .where(inArray(responsibilityRuns.responsibilityId, [...byId.keys()]))
          .orderBy(desc(responsibilityRuns.createdAt))
          .limit(COMPLETED_LIMIT * 2);
        for (const { run, eventType, source } of runs) {
          const goal = byId.get(run.responsibilityId);
          if (!goal) continue;
          const item: ActivityItem = {
            id: `responsibility-run:${run.id}`,
            kind: "responsibility",
            title: goal.title,
            detail:
              clip(run.error ?? run.replyText) ?? `${source}/${eventType}`,
            status: run.status,
            at: iso(run.finishedAt ?? run.startedAt ?? run.createdAt),
            channelId: goal.channelId,
            needsYou: run.status === "waiting",
            stoppable: false,
            cancellable: false,
          };
          if (run.status === "queued") activity.scheduled.push(item);
          else if (run.status === "running" || run.status === "waiting")
            activity.inProgress.push(item);
          else activity.completed.push(item);
        }
      }

      // Delegated tasks: hops this Bot asked for, or was asked to do, on this person's behalf.
      const hops = await database
        .select()
        .from(workItems)
        .where(handoffsFor(ownerUserId, agentId))
        .orderBy(desc(workItems.createdAt))
        .limit(COMPLETED_LIMIT * 2);
      const hopChannels = await channelsForThreads(
        hops.map((hop) => (hop.payload as HandoffPayload).threadId ?? ""),
      );
      for (const hop of hops) {
        const work = hop.payload as HandoffPayload;
        const asked = work.fromBotId === agentId;
        const other = asked
          ? (work.toName ?? work.toBotId)
          : (work.fromName ?? work.fromBotId);
        const running =
          !hop.finishedAt &&
          hop.claimedBy !== null &&
          hop.leaseUntil !== null &&
          hop.leaseUntil.getTime() > now;
        const gaveUp = !hop.finishedAt && hop.attempts >= DEFAULT_MAX_ATTEMPTS;
        const item: ActivityItem = {
          id: hop.key,
          kind: "handoff",
          title: clip(work.task, 120) ?? "Delegated task",
          detail: asked ? `Delegated to ${other}` : `Asked by ${other}`,
          status: hop.finishedAt
            ? hop.lastError === "Stopped by the person"
              ? "stopped"
              : "delivered"
            : gaveUp
              ? "failed"
              : running
                ? "running"
                : hop.attempts > 0
                  ? "retrying"
                  : "queued",
          at: iso(hop.finishedAt ?? hop.updatedAt),
          channelId: hopChannels.get(work.threadId ?? "") ?? null,
          needsYou: gaveUp,
          stoppable: !hop.finishedAt && !gaveUp,
          cancellable: false,
        };
        if (hop.finishedAt) activity.completed.push(item);
        else if (running || gaveUp) activity.inProgress.push(item);
        else activity.scheduled.push(item);
      }

      // Approvals waiting on this person for this Bot.
      const approvals = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, ownerUserId),
            eq(approvalRequests.status, "pending"),
            sql`${approvalRequests.action}->>'botId' = ${agentId}`,
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(50);
      const approvalChannels = await channelsForThreads(
        approvals.map((approval) => approval.action.threadId),
      );
      for (const approval of approvals)
        activity.inProgress.push({
          id: `approval:${approval.id}`,
          kind: "approval",
          title: `Approve ${approval.action.toolRef}`,
          detail: approval.action.effect,
          status: "waiting for you",
          at: iso(approval.createdAt),
          channelId: approvalChannels.get(approval.action.threadId) ?? null,
          needsYou: true,
          stoppable: false,
          cancellable: false,
        });

      // Questions this Bot asked this person and is waiting on.
      const questions = await database
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            isNull(workItems.finishedAt),
            sql`${workItems.payload}->>'actorId' = ${ownerUserId}`,
            sql`coalesce(${workItems.payload}->>'sourceBotId', ${workItems.payload}->>'botId') = ${agentId}`,
          ),
        )
        .orderBy(desc(workItems.createdAt))
        .limit(50);
      const questionChannels = await channelsForThreads(
        questions.map((row) => (row.payload as QuestionPayload).threadId ?? ""),
      );
      for (const row of questions) {
        const question = row.payload as QuestionPayload;
        activity.inProgress.push({
          id: `question:${row.key}`,
          kind: "question",
          title: clip(question.question, 160) ?? "A question",
          detail: null,
          status: "waiting for you",
          at: iso(row.createdAt),
          channelId:
            question.channelId ??
            questionChannels.get(question.threadId ?? "") ??
            null,
          needsYou: true,
          stoppable: false,
          cancellable: false,
        });
      }

      // Follow-ups the Bot scheduled for itself.
      const wakeUps = await database
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, WAKE_UP_KIND),
            sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
            sql`${workItems.payload}->>'agentId' = ${agentId}`,
          ),
        )
        .orderBy(desc(workItems.runAt))
        .limit(COMPLETED_LIMIT * 2);
      for (const row of wakeUps) {
        const payload = row.payload as WakeUpPayload;
        const running =
          !row.finishedAt &&
          row.claimedBy !== null &&
          row.leaseUntil !== null &&
          row.leaseUntil.getTime() > now;
        const item: ActivityItem = {
          id: row.key,
          kind: "follow_up",
          title: clip(payload.reason, 160) ?? "Follow-up",
          detail: clip(payload.outcome?.detail ?? payload.instruction),
          status: row.finishedAt
            ? (payload.outcome?.status ?? "done")
            : running
              ? "running"
              : "scheduled",
          at: row.finishedAt
            ? iso(payload.outcome?.at ?? row.finishedAt)
            : iso(payload.dueAt ?? row.runAt),
          channelId: payload.channelId ?? null,
          needsYou: false,
          stoppable: false,
          cancellable: !row.finishedAt && !running,
        };
        if (row.finishedAt) activity.completed.push(item);
        else if (running) activity.inProgress.push(item);
        else activity.scheduled.push(item);
      }

      activity.inProgress.sort((a, b) => b.at.localeCompare(a.at));
      activity.scheduled.sort((a, b) => a.at.localeCompare(b.at));
      activity.completed.sort((a, b) => b.at.localeCompare(a.at));
      activity.completed = activity.completed.slice(0, COMPLETED_LIMIT);
      return activity;
    },

    /**
     * Stop a delegated task that has not finished, on this person's behalf.
     *
     * Marked finished with a reason, which the hop runner reads as "no longer mine": a queued hop is
     * never claimed, and one being delivered has its relay dropped because `finish` answers false.
     * Returns what was stopped, or null when there was nothing of theirs to stop.
     */
    async stopHandoff(
      ownerUserId: string,
      agentId: string,
      key: string,
    ): Promise<{ key: string; toBotId: string | null } | null> {
      const [row] = await database
        .update(workItems)
        .set({
          finishedAt: sql`now()`,
          claimedBy: null,
          leaseUntil: null,
          lastError: "Stopped by the person",
          updatedAt: sql`now()`,
        })
        .where(
          and(
            handoffsFor(ownerUserId, agentId),
            eq(workItems.key, key),
            isNull(workItems.finishedAt),
          ),
        )
        .returning({ key: workItems.key, payload: workItems.payload });
      if (!row) return null;
      return {
        key: row.key,
        toBotId: (row.payload as HandoffPayload).toBotId ?? null,
      };
    },

    /** Per Bot: how many things wait on this person, and how many conversations have unread replies. */
    async attention(ownerUserId: string): Promise<BotAttention[]> {
      const byBot = new Map<string, BotAttention>();
      const entry = (agentId: string) => {
        let found = byBot.get(agentId);
        if (!found) {
          found = {
            agentId,
            questions: 0,
            approvals: 0,
            handoffs: 0,
            unread: 0,
          };
          byBot.set(agentId, found);
        }
        return found;
      };

      const questions = await database
        .select({
          agentId: sql<string>`coalesce(${workItems.payload}->>'sourceBotId', ${workItems.payload}->>'botId')`,
          total: sql<number>`count(*)::int`,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            isNull(workItems.finishedAt),
            sql`${workItems.payload}->>'actorId' = ${ownerUserId}`,
          ),
        )
        .groupBy(
          sql`coalesce(${workItems.payload}->>'sourceBotId', ${workItems.payload}->>'botId')`,
        );
      for (const row of questions)
        if (row.agentId) entry(row.agentId).questions += row.total;

      const approvals = await database
        .select({
          agentId: sql<string>`${approvalRequests.action}->>'botId'`,
          total: sql<number>`count(*)::int`,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, ownerUserId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .groupBy(sql`${approvalRequests.action}->>'botId'`);
      for (const row of approvals)
        if (row.agentId) entry(row.agentId).approvals += row.total;

      // A delegated task that ran out of attempts: the chain stopped and only the person can pick it up.
      const handoffs = await database
        .select({
          agentId: sql<string>`${workItems.payload}->>'fromBotId'`,
          total: sql<number>`count(*)::int`,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, HANDOFF_KIND),
            isNull(workItems.finishedAt),
            gte(workItems.attempts, DEFAULT_MAX_ATTEMPTS),
            sql`${workItems.payload}->>'actorId' = ${ownerUserId}`,
            sql`${workItems.payload}->>'answerIn' is null`,
          ),
        )
        .groupBy(sql`${workItems.payload}->>'fromBotId'`);
      for (const row of handoffs)
        if (row.agentId) entry(row.agentId).handoffs += row.total;

      // The same rule as the roster's unread dot: a Bot spoke after this person last looked.
      const unread = await database
        .select({
          agentId: channelAgents.agentId,
          total: sql<number>`count(distinct ${channels.id})::int`,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, ownerUserId),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .where(
          and(
            isNull(channels.deletedAt),
            sql`${channels.lastMessageAgentId} is not null`,
            or(
              isNull(channelMemberships.lastReadAt),
              sql`${channels.lastMessageAt} > ${channelMemberships.lastReadAt}`,
            ),
          ),
        )
        .groupBy(channelAgents.agentId);
      for (const row of unread) entry(row.agentId).unread += row.total;

      return [...byBot.values()];
    },
  };
}
