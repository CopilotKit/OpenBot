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
import { approvalPhrase } from "@openbot/shared/tool-name";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { HANDOFF_KIND } from "../agents/handoff";
import { WAKE_UP_KIND, type WakeUpPayload } from "../agents/wake-up";
import {
  APPROVAL_CARDS,
  DECISION_KIND,
  type DecisionPayload,
} from "../approvals/decision-waits";
import { plainLine } from "../channels/text";
import type { Database } from "../db/client";
import {
  approvalRequests,
  botTasks,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  proactivePings,
  proactiveSuggestions,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  responsibilityTriggers,
  routineRuns,
  routines,
  workItems,
} from "../db/schema";
import { routineRunsGoal } from "../responsibilities/types";
import { describeCron } from "../routines/schedule";
import { listedTask } from "../tasks/store";
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
  /**
   * Active goals with nothing to start them on their own: no schedule and no event. They run when
   * somebody asks, with Run now on the goal. Not `scheduled`, which is work lined up for a time or an
   * event: a goal that only runs when asked was counted there, and a Bot page said "2 scheduled".
   */
  onDemand: ActivityItem[];
  completed: ActivityItem[];
};

export type BotAttention = {
  agentId: string;
  questions: number;
  approvals: number;
  handoffs: number;
  unread: number;
  /** Open items this Bot's check-ins raised, waiting for the person to start or hide. */
  items: number;
};

const COMPLETED_LIMIT = 25;

/**
 * Raised in the conversation or thread of one of the person's tasks that their task list shows.
 *
 * What waits on the person there is counted once, as that task needing input (`tasks.counts`, which
 * reads the same approvals and questions by the same rule, tasks/state.ts), so the attention counts
 * leave it out of `approvals` and `questions`: a task waiting on one approval is one thing that needs
 * the person, not two.
 */
const inListedTask = (ownerUserId: string, channelId: SQL, threadId: SQL) =>
  sql`exists (
    select 1 from ${botTasks}
    left join ${intelligenceChannelMappings}
      on ${intelligenceChannelMappings.channelId} = ${botTasks.channelId}
      and ${intelligenceChannelMappings.userId} = ${ownerUserId}
    where ${botTasks.ownerUserId} = ${ownerUserId}
      and ${listedTask}
      and (${botTasks.channelId} = ${channelId} or ${intelligenceChannelMappings.threadId} = ${threadId})
  )`;
/** The conversation a waiting card was asked in is still there: a deleted one has nothing to answer. */
const inOpenConversation = (channelId: SQL) =>
  sql`exists (
    select 1 from ${channels}
    where ${channels.id} = ${channelId} and ${channels.deletedAt} is null
  )`;
/** A card still waiting on this person: asked in a conversation of theirs that is still there. */
const openDecisionFor = (ownerUserId: string) =>
  and(
    eq(workItems.kind, DECISION_KIND),
    isNull(workItems.finishedAt),
    sql`${workItems.payload}->>'actorId' = ${ownerUserId}`,
    inOpenConversation(sql`${workItems.payload}->>'channelId'`),
  );
/**
 * One line of a row, as plain text. A run's reply and a follow-up's note are written by the Bot, in
 * Markdown, and a row draws text, so `heading.txt` in backticks and **bold** showed their marks.
 * Flattened the way the sidebar flattens a conversation's last message (`previewOf` in
 * `channels/routes.ts`), at the same 200 characters.
 */
const clip = (text: string | null | undefined, max = 200) =>
  (text && plainLine(text, max)) || null;
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
        onDemand: [],
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
            // What the person called it, else its instruction, whole: the page shortens it to fit
            // and shows it all on hover. The store caps an instruction at 2,000 characters.
            title: routine.title || routine.instruction || "Routine",
            // In words, by the helper the Routines page uses, so the two screens say it the same way.
            detail: `${describeCron(routine.cron)} (${routine.timezone})`,
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
            title: routine.title || routine.instruction || "Routine",
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

      // Responsibilities: an active one is standing work; each run is a piece of it. One a routine
      // runs or an event wakes is lined up for it; one nothing starts runs only when somebody asks.
      const goals = await database
        .select()
        .from(responsibilities)
        .where(
          and(
            eq(responsibilities.ownerUserId, ownerUserId),
            eq(responsibilities.agentId, agentId),
          ),
        );
      // A goal's triggers wake it as its subscriptions do; a paused one starts nothing.
      const triggers = goals.length
        ? await database
            .select({
              goalId: responsibilityTriggers.responsibilityId,
              kind: responsibilityTriggers.kind,
            })
            .from(responsibilityTriggers)
            .where(
              and(
                eq(responsibilityTriggers.ownerUserId, ownerUserId),
                eq(responsibilityTriggers.enabled, true),
                inArray(
                  responsibilityTriggers.responsibilityId,
                  goals.map((goal) => goal.id),
                ),
              ),
            )
        : [];
      for (const goal of goals) {
        if (goal.status !== "active") continue;
        /*
         * The routines that run it, by the rule its run is told it repeats by. FOUND LIVE: a goal a
         * daily routine runs was listed under On demand as "Runs when asked", below the routine that
         * runs it every morning. It says when it runs, from the soonest routine, and sits with them.
         */
        const runBy = ownedRoutines
          .filter(
            (routine) => routine.enabled && routineRunsGoal(routine, goal),
          )
          .sort(
            (first, second) =>
              first.nextRunAt.getTime() - second.nextRunAt.getTime(),
          );
        const wakesOn = [
          ...goal.subscriptions.map((s) => `${s.source}/${s.eventType}`),
          ...triggers
            .filter((trigger) => trigger.goalId === goal.id)
            .map((trigger) => trigger.kind),
        ];
        const starts = [
          ...(runBy.length
            ? [
                `${runBy
                  .map(
                    (routine) =>
                      `${describeCron(routine.cron)} (${routine.timezone})`,
                  )
                  .join(
                    "; ",
                  )}, from its ${runBy.length === 1 ? "routine" : "routines"}`,
              ]
            : []),
          ...(wakesOn.length ? [`Wakes on ${wakesOn.join(", ")}`] : []),
        ];
        (starts.length ? activity.scheduled : activity.onDemand).push({
          id: `responsibility:${goal.id}`,
          kind: "responsibility",
          title: goal.title,
          detail: starts.length ? starts.join(" · ") : "Runs when asked",
          status: "active",
          at: iso(runBy[0]?.nextRunAt ?? goal.updatedAt),
          channelId: goal.channelId,
          needsYou: false,
          stoppable: false,
          cancellable: false,
        });
      }
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
            // A run, not the goal: "Goal · succeeded" under the goal's own title read as a second
            // goal that had finished, beside the one still active.
            title: `Run of ${goal.title}`,
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
      for (const approval of approvals) {
        // In the words its card uses: "Click the link “Python” on en.wikipedia.org", never the
        // tool's id and its effect ("Approve computer_click", "write").
        const phrase = approvalPhrase(approval.action);
        activity.inProgress.push({
          id: `approval:${approval.id}`,
          kind: "approval",
          title: phrase.charAt(0).toUpperCase() + phrase.slice(1),
          detail: approval.action.policy?.reason ?? null,
          status: "waiting for you",
          at: iso(approval.createdAt),
          channelId: approvalChannels.get(approval.action.threadId) ?? null,
          needsYou: true,
          stoppable: false,
          cancellable: false,
        });
      }

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

      // Cards this Bot asked with in the conversation and is waiting on.
      const decisions = await database
        .select()
        .from(workItems)
        .where(
          and(
            openDecisionFor(ownerUserId),
            sql`${workItems.payload}->>'botId' = ${agentId}`,
          ),
        )
        .orderBy(desc(workItems.createdAt))
        .limit(50);
      for (const row of decisions) {
        const decision = row.payload as DecisionPayload;
        const approval = APPROVAL_CARDS.includes(decision.toolName);
        activity.inProgress.push({
          id: `decision:${row.key}`,
          kind: approval ? "approval" : "question",
          title:
            clip(decision.title, 160) ??
            (approval ? "An approval" : "A question"),
          detail: null,
          status: "waiting for you",
          at: iso(row.createdAt),
          channelId: decision.channelId,
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
            items: 0,
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
            sql`not ${inListedTask(
              ownerUserId,
              sql`${workItems.payload}->>'channelId'`,
              sql`${workItems.payload}->>'threadId'`,
            )}`,
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
            sql`not ${inListedTask(
              ownerUserId,
              sql`null`,
              sql`${approvalRequests.action}->>'threadId'`,
            )}`,
          ),
        )
        .groupBy(sql`${approvalRequests.action}->>'botId'`);
      for (const row of approvals)
        if (row.agentId) entry(row.agentId).approvals += row.total;

      // Cards asked in the conversation: the approval card is an approval, the rest are questions.
      const decisions = await database
        .select({
          agentId: sql<string>`${workItems.payload}->>'botId'`,
          toolName: sql<string>`${workItems.payload}->>'toolName'`,
          total: sql<number>`count(*)::int`,
        })
        .from(workItems)
        .where(
          and(
            openDecisionFor(ownerUserId),
            sql`not ${inListedTask(
              ownerUserId,
              sql`${workItems.payload}->>'channelId'`,
              sql`${workItems.payload}->>'threadId'`,
            )}`,
          ),
        )
        .groupBy(
          sql`${workItems.payload}->>'botId'`,
          sql`${workItems.payload}->>'toolName'`,
        );
      for (const row of decisions)
        if (row.agentId)
          entry(row.agentId)[
            APPROVAL_CARDS.includes(row.toolName) ? "approvals" : "questions"
          ] += row.total;

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

      /*
       * What check-ins raised and the person has not decided: listed in the app the moment it is
       * raised, pinged or not, and whatever the Bot may notify them of. Badges always show.
       */
      const items = await database
        .select({
          agentId: proactiveSuggestions.agentId,
          total: sql<number>`count(*)::int`,
        })
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, ownerUserId),
            eq(proactiveSuggestions.status, "open"),
          ),
        )
        .groupBy(proactiveSuggestions.agentId);
      for (const row of items) entry(row.agentId).items += row.total;

      return [...byBot.values()];
    },

    /**
     * Per Bot, the conversation of the newest thing it waits on this person for: a question, a card
     * in the conversation, an approval or a stalled hand-off. A notice about that Bot opens there.
     *
     * Read without leaving out what a task waits on, as the counts do: a task needing input waits on
     * one of these, in the task's own conversation, and that is where its notice should open too.
     */
    async waitingIn(ownerUserId: string): Promise<Map<string, string>> {
      const newest = new Map<string, { channelId: string; at: number }>();
      const offer = (
        agentId: string | null,
        channelId: string | null | undefined,
        at: Date,
      ) => {
        if (!agentId || !channelId) return;
        const known = newest.get(agentId);
        if (!known || at.getTime() > known.at)
          newest.set(agentId, { channelId, at: at.getTime() });
      };
      const questionBot = sql<string>`coalesce(${workItems.payload}->>'sourceBotId', ${workItems.payload}->>'botId')`;
      const approvalBot = sql<string>`${approvalRequests.action}->>'botId'`;
      const handoffBot = sql<string>`${workItems.payload}->>'fromBotId'`;
      const decisionBot = sql<string>`${workItems.payload}->>'botId'`;
      const [questions, decisions, approvals, handoffs] = await Promise.all([
        database
          .selectDistinctOn([questionBot], {
            agentId: questionBot,
            channelId: sql<string | null>`${workItems.payload}->>'channelId'`,
            threadId: sql<string | null>`${workItems.payload}->>'threadId'`,
            at: workItems.createdAt,
          })
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, "person.question"),
              isNull(workItems.finishedAt),
              sql`${workItems.payload}->>'actorId' = ${ownerUserId}`,
            ),
          )
          .orderBy(questionBot, desc(workItems.createdAt)),
        database
          .selectDistinctOn([decisionBot], {
            agentId: decisionBot,
            channelId: sql<string>`${workItems.payload}->>'channelId'`,
            at: workItems.createdAt,
          })
          .from(workItems)
          .where(openDecisionFor(ownerUserId))
          .orderBy(decisionBot, desc(workItems.createdAt)),
        database
          .selectDistinctOn([approvalBot], {
            agentId: approvalBot,
            threadId: sql<string>`${approvalRequests.action}->>'threadId'`,
            at: approvalRequests.createdAt,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.ownerUserId, ownerUserId),
              eq(approvalRequests.status, "pending"),
            ),
          )
          .orderBy(approvalBot, desc(approvalRequests.createdAt)),
        database
          .selectDistinctOn([handoffBot], {
            agentId: handoffBot,
            threadId: sql<string | null>`${workItems.payload}->>'threadId'`,
            at: workItems.updatedAt,
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
          .orderBy(handoffBot, desc(workItems.updatedAt)),
      ]);
      const threads = await channelsForThreads([
        ...questions.map((row) => row.threadId ?? ""),
        ...approvals.map((row) => row.threadId),
        ...handoffs.map((row) => row.threadId ?? ""),
      ]);
      for (const row of questions)
        offer(
          row.agentId,
          row.channelId ?? threads.get(row.threadId ?? ""),
          row.at,
        );
      for (const row of decisions) offer(row.agentId, row.channelId, row.at);
      for (const row of approvals)
        offer(row.agentId, threads.get(row.threadId), row.at);
      for (const row of handoffs)
        offer(row.agentId, threads.get(row.threadId ?? ""), row.at);
      return new Map(
        [...newest].map(([agentId, { channelId }]) => [agentId, channelId]),
      );
    },

    /**
     * The person's newest ping, across all their Bots, or null. The app fires one browser
     * notification each time this changes, never one per item.
     */
    async lastPing(ownerUserId: string): Promise<string | null> {
      const [row] = await database
        .select({ id: proactivePings.id })
        .from(proactivePings)
        .where(eq(proactivePings.ownerUserId, ownerUserId))
        .orderBy(desc(proactivePings.createdAt), desc(proactivePings.id))
        .limit(1);
      return row?.id ?? null;
    },
  };
}
