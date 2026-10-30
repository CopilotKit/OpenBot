/**
 * What the proactive slices promise each other: the shapes their routes answer with, and the calls
 * one slice makes into another. Types only. Each slice implements its side; none changes a shape
 * here without the others agreeing.
 *
 * The design these follow: a Bot checks quietly, at most hourly, and reads only what is new. When a
 * check-in raises something, the person hears at most once an hour, every Bot's waiting items folded
 * into one ping, each item naming its Bot. Start makes an item a task in a conversation of its own.
 * Hide remembers it for 30 days. An admin can turn check-ins off, cap them per Bot, and see how
 * often items are started.
 *
 * Who owns what:
 * - check-ins, pings and the item routes: the proactive engine (`proactive/*`);
 * - delivery of a ping: `delivery/*` ({@link AttentionDelivery});
 * - tasks: `tasks/*` ({@link TaskService});
 * - the admin switch, the cap and the numbers: `admin/*` ({@link ProactiveAdmin}).
 *
 * Dates are ISO strings in every payload, as JSON carries them.
 */
import type { BotTaskOrigin } from "../db/schema/tasks";

/* ------------------------------------------------------------------------------------------------
 * The run ledger's words (`proactive_runs`).
 * ---------------------------------------------------------------------------------------------- */

/** What started a check-in: the sweep, or the person's Run now. */
export type ProactiveRunTrigger = "schedule" | "run_now";

/**
 * How a check-in ended. `quiet` found nothing and sent nothing; `raised` opened at least one item;
 * `skipped` never reached the model. `running` is the only unfinished outcome.
 */
export type ProactiveRunOutcome =
  | "running"
  | "quiet"
  | "raised"
  | "failed"
  | "skipped";

/**
 * Why a check-in was skipped before any model call. `busy` means another check-in for the same
 * setting was already running.
 */
export type ProactiveSkipReason =
  | "off_admin"
  | "off_person"
  | "paused"
  | "capped"
  | "unreachable"
  | "no_sources"
  | "busy";

/* ------------------------------------------------------------------------------------------------
 * `/api/proactive` (proactive engine).
 * ---------------------------------------------------------------------------------------------- */

/** One background-check setting as `GET /api/proactive/settings` lists it. Unchanged. */
export type ProactiveSettingPayload = {
  id: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  focus: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "idle" | "running" | "succeeded" | "error";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * `GET /api/proactive/settings`. `allowed` is false when an admin turned check-ins off for this
 * person, so the person's own switch can say who turned it off.
 */
export type ProactiveSettingsResponse = {
  settings: ProactiveSettingPayload[];
  allowed: boolean;
};

/**
 * One item a check-in raised, as `GET /api/proactive/suggestions` returns it. Open items only.
 *
 * `detail` is why it was raised. A new item always has a source (`sourceApp`, `sourceRef`); items
 * from before this change may not. `pingId` is the ping that carried it, null while it waits for the
 * person's hourly slot.
 */
export type SuggestionPayload = {
  id: string;
  ownerUserId: string;
  agentId: string;
  settingId: string;
  runId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  status: "open" | "dismissed" | "started" | "superseded";
  pingId: string | null;
  deliveredAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

/** `GET /api/proactive/suggestions`. */
export type SuggestionsResponse = { suggestions: SuggestionPayload[] };

/** `POST /api/proactive/suggestions/:id/start`: the item, now started, and the task it opened. */
export type StartSuggestionResponse = {
  suggestion: SuggestionPayload;
  task: { id: string; channelId: string };
};

/** `POST /api/proactive/suggestions/:id/dismiss` (Hide). Unchanged. */
export type DismissSuggestionResponse = { suggestion: SuggestionPayload };

/* ------------------------------------------------------------------------------------------------
 * `/api/tasks` (tasks).
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a task stands, read on every request from the work queue, the approval inbox and the
 * questions its Bot asked, never stored. First match wins, in this order:
 * - `needs_input`: an approval or a question in its conversation waits on the person;
 * - `working`: its turn is queued, running, or due its one retry;
 * - `resolved`: the person marked it done, and no turn was accepted after;
 * - `failed`: its turn ran out of runs, and nothing was said in its conversation since;
 * - `ready_for_review`: its turn finished and the Bot replied.
 */
export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "failed"
  | "ready_for_review";

/** One task, as `GET /api/tasks` and `GET /api/tasks/:id` return it. */
export type TaskPayload = {
  id: string;
  agentId: string;
  /** The task's own conversation, where the person reads it and replies. */
  channelId: string;
  /** That conversation's thread, which its approvals and questions name. Null once it is gone. */
  threadId: string | null;
  title: string;
  why: string | null;
  origin: BotTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status: TaskStatus;
  /** Why its turn couldn't finish, in plain words, while `failed`. Null otherwise. */
  failure: string | null;
  failedAt: string | null;
  /** One line on what comes next, from the last thing said in its conversation. */
  next: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `GET /api/tasks`: open tasks, and resolved ones for 7 days after. */
export type TasksResponse = { tasks: TaskPayload[] };

/** `GET /api/tasks/:id`, and `POST /api/tasks/:id/resolve`, `/reopen` and `/again`. */
export type TaskResponse = { task: TaskPayload };

/** What a person's tasks from one Bot need from them, for the "Needs you" counts. */
export type BotTaskCounts = {
  agentId: string;
  needsInput: number;
  ready: number;
  failed: number;
};

/** The tasks module, as the proactive engine and the attention counts call it. */
export type TaskService = {
  /**
   * Open a task for an item the person started: a new conversation with the item's Bot and a
   * `bot_tasks` row, in one transaction, then the turn queued and kicked at once. The ask runs as
   * the person's own turn, so every send or change meets the approval gate. Idempotent on
   * `item.id`: a second call returns the task the first one opened.
   */
  startFromItem(input: {
    ownerUserId: string;
    item: {
      id: string;
      agentId: string;
      title: string;
      /** The item's why. */
      detail: string;
      sourceApp: string | null;
      sourceLink: string | null;
    };
  }): Promise<{ id: string; channelId: string }>;
  /** Per Bot, the person's tasks that need input, are ready for review, or failed. */
  counts(ownerUserId: string): Promise<BotTaskCounts[]>;
};

/* ------------------------------------------------------------------------------------------------
 * `GET /api/bots/attention`.
 * ---------------------------------------------------------------------------------------------- */

/** One Bot's row: today's counts, plus its open items and the tasks that need the person. */
export type BotAttentionPayload = {
  agentId: string;
  name: string;
  questions: number;
  approvals: number;
  handoffs: number;
  unread: number;
  paused: boolean;
  notify: "all" | "needs_input" | "none";
  /** Open items from this Bot's check-ins. */
  items: number;
  tasks: Omit<BotTaskCounts, "agentId">;
};

/**
 * `GET /api/bots/attention`. `lastPingId` is the person's newest ping, across all their Bots: the
 * app fires one browser notification each time it changes, never one per item.
 */
export type AttentionResponse = {
  bots: BotAttentionPayload[];
  lastPingId: string | null;
};

/* ------------------------------------------------------------------------------------------------
 * Delivery of a ping.
 * ---------------------------------------------------------------------------------------------- */

/** One item a ping carries, with the Bot it came from. */
export type AttentionItem = {
  suggestionId: string;
  agentId: string;
  /** The Bot's name, as the message names it. */
  agentName: string;
  title: string;
  why: string;
  sourceApp: string | null;
};

/** One ping to one person: every item no ping had carried yet, across all their Bots. */
export type AttentionPing = {
  /** The `proactive_pings` row. Delivery builds its dedupe keys from it. */
  pingId: string;
  ownerUserId: string;
  /** The folded message for Slack, Teams and SMS, naming each item's Bot. */
  text: string;
  /** The one line a phone push shows. */
  pushBody: string;
  /** In the order `text` lists them. */
  items: AttentionItem[];
};

/** Delivery, as the proactive engine calls it. Delivery kind and routing kind `attention`. */
export type AttentionDelivery = {
  /**
   * Offer one ping: once to each of the person's push devices, and at most one message per
   * platform on Slack and Teams, into the person's most recently used binding on that platform.
   * Replies there reach that binding's Bot, as any reply does. A person with no Slack or Teams
   * binding gets push and the app. The person's routing for `attention` picks the transports.
   * Safe to call again for the same ping: it sends once.
   */
  notifyAttention(ping: AttentionPing): Promise<void>;
};

/* ------------------------------------------------------------------------------------------------
 * Admin.
 * ---------------------------------------------------------------------------------------------- */

/** Admin controls, as the proactive engine asks them before any model call. */
export type ProactiveAdmin = {
  /** Whether capability `proactive` is on for this person (organization, role; a group only widens). */
  proactiveAllowed(ownerUserId: string): Promise<boolean>;
  /**
   * How many check-ins this Bot may run for one person in any 24 hours: 24 unless an admin changed
   * it (enterprise setting `proactiveDailyRuns`, stored as `proactive_daily_runs`, changed through
   * the existing `PUT /api/admin/settings/proactiveDailyRuns` with `{ value }`). Skipped runs do not
   * count.
   */
  proactiveDailyRuns(agentId: string): Promise<number>;
};

/** One Bot's numbers on the admin's Check-ins page. Counts only: no titles, no people. */
export type BotProactiveMetrics = {
  agentId: string;
  name: string;
  /** People with check-ins on for this Bot. */
  peopleOn: number;
  runs: {
    quiet: number;
    raised: number;
    failed: number;
    skipped: Record<ProactiveSkipReason, number>;
  };
  items: {
    raised: number;
    started: number;
    hidden: number;
    /** Cleared by the Bot as no longer needed. */
    cleared: number;
    open: number;
  };
  /** started ÷ (started + hidden), or null when neither happened. */
  acceptance: number | null;
  /** This Bot's items that a ping carried. */
  pinged: number;
};

/**
 * `GET /api/admin/proactive?days=7|30`. A ping folds every Bot's items for one person, so pings
 * are counted once for everybody, not per Bot.
 */
export type ProactiveMetricsResponse = {
  days: 7 | 30;
  /** The daily cap in force. */
  dailyRuns: number;
  bots: BotProactiveMetrics[];
  pings: { sent: number; itemsPerPing: number | null };
};
