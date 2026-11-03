/**
 * Check-ins' settings, items, run ledger and pings, as Intelligence's agent schedules hold them.
 *
 * WHERE EACH THING LIVES. A setting is a `check-in-settings` record, held in memory on every instance
 * by the schedule directory (`schedules/directory.ts`) and read from there; a write goes through the
 * directory, so this instance reads its own write at once and every other one hears of it. The run
 * ledger (`check-in-runs`), the items (`check-in-suggestions`) and the pings (`check-in-pings`) are
 * history, read from Intelligence when something asks. What stays here is this deployment's own: the
 * person's switches (`users`), their Bots' lifecycle (`bot_lifecycle`), the tasks and the work queue.
 *
 * NO TRANSACTION HELD ACROSS INTELLIGENCE. What used to be a row lock or an advisory lock is now a
 * named lease (`work/local-lock.ts`) for a read-decide-write across several records, a version match
 * (If-Match) for a change to one record, and Intelligence's unique rules for the races they guarded
 * before: one setting per person and Bot, one running check-in per setting, one open item per title.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditEvents, users } from "../db/schema/core";
import { botLifecycle } from "../db/schema/lifecycle";
import { botTasks } from "../db/schema/tasks";
import { workItems } from "../db/schema/work";
import { recordOptOut, withResearchDefaultsLock } from "../memory/defaults";
import {
  ScheduleAlreadyExistsError,
  ScheduleConflictError,
  ScheduleDeletedError,
  ScheduleNotFoundError,
  type SchedulePage,
  ScheduleVersionConflictError,
} from "../schedules/client";
import { schedules } from "../schedules/directory";
import type {
  CheckInRunRecord,
  CheckInSettingRecord,
  CheckInSuggestionRecord,
  ScheduleChanges,
} from "../schedules/types";
import { withLocalLock } from "../work/local-lock";
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
  sameThing,
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
 * What this person had before a check-in: what the repeat check refuses against, and what the
 * check-in is told (`window.ts`). Titles and links, never the mail they came from.
 *
 * Open items, tasks and what they hid are the person's from every one of their Bots, each naming its
 * Bot: the same request is one thing to them whichever Bot found it, so it is raised once, and once
 * hidden it stays hidden from all of them. What a check-in is told of them is its own Bot's alone
 * (see `contextOf` in `engine.ts`). Started is only ever told, so it is this Bot's alone.
 */
export type PriorItems = {
  open: {
    id: string;
    agentId: string;
    title: string;
    sourceLink: string | null;
  }[];
  tasks: { agentId: string; title: string; sourceLink: string | null }[];
  hidden: {
    agentId: string;
    title: string;
    sourceLink: string | null;
    sourceApp: string | null;
  }[];
  started: { title: string }[];
};

/**
 * How many of the person's open items, tasks and hidden items the repeat check reads, across all
 * their Bots. Far more than anybody keeps open.
 */
const PRIOR_LIMIT = 200;

/**
 * A check-in that couldn't read an app records it in its run's `error`: this marker, then the apps'
 * names. On a failed run that is the reason the person reads on the Bot's check-ins; on one that
 * raised something anyway, it keeps the next check-in's window open from before it (`windowStart`).
 */
const UNREACHED = "unreached:";
/** How many app names one run's error keeps, so it fits the column's 500 characters. */
const UNREACHED_KEPT = 5;

/** The `error` a check-in that couldn't read these apps is closed with. */
export function unreachedError(apps: readonly string[]): string {
  return `${UNREACHED}${JSON.stringify(
    apps.slice(0, UNREACHED_KEPT).map((app) => app.slice(0, 80)),
  )}`;
}

/** The apps a check-in couldn't read, from its `error`, or null when that is not why it failed. */
export function unreachedApps(error: string | null): string[] | null {
  if (!error?.startsWith(UNREACHED)) return null;
  try {
    const apps: unknown = JSON.parse(error.slice(UNREACHED.length));
    return Array.isArray(apps) &&
      apps.length > 0 &&
      apps.every((app) => typeof app === "string")
      ? apps
      : null;
  } catch {
    return null;
  }
}

/**
 * How long the run ledger and old pings are kept: the admin's longest window of numbers, and as long
 * as Hide holds. Nothing reads further back: the daily cap reads a day and the window reads the last
 * check-in, which after a month away is the last day anyway.
 */
export const PROACTIVE_LEDGER_DAYS = 30;

/** A setting's run as the ledger keeps it. */
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

/**
 * How many times a change to one record is tried when another writer changed it first. Each try reads
 * the record again, so this is only ever reached by a record changing faster than it can be read.
 */
const VERSION_TRIES = 5;

/** The name of the lease that serializes what changes which items a person has open. */
const itemsLock = (owner: string) => `proactive-items:${owner}`;

/** A setting as the rest of OpenBot reads it: Intelligence's version and deletion are its own. */
export function settingOf(record: CheckInSettingRecord): ProactiveSetting {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    agentId: record.agentId,
    channelId: record.channelId,
    threadId: record.threadId,
    focus: record.focus,
    enabled: record.enabled,
    intervalMinutes: record.intervalMinutes,
    nextRunAt: record.nextRunAt,
    lastRunAt: record.lastRunAt,
    lastStatus: record.lastStatus,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** An item as the rest of OpenBot reads it. */
export function suggestionOf(
  record: CheckInSuggestionRecord,
): ProactiveSuggestion {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    agentId: record.agentId,
    settingId: record.settingId,
    runId: record.runId,
    title: record.title,
    detail: record.detail,
    sourceApp: record.sourceApp,
    sourceRef: record.sourceRef,
    sourceLink: record.sourceLink,
    status: record.status,
    dedupeKey: record.dedupeKey,
    pingId: record.pingId,
    deliveredAt: record.deliveredAt,
    resolvedAt: record.resolvedAt,
    createdAt: record.createdAt,
  };
}

function runOf(record: CheckInRunRecord): ProactiveRunRow {
  return {
    id: record.id,
    settingId: record.settingId,
    outcome: record.outcome,
    skipReason: record.skipReason,
    trigger: record.trigger,
    threadId: record.threadId,
    itemsRaised: record.itemsRaised,
    reads: record.reads,
    error: record.error,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

/** The live setting, from this instance's memory, reading through on a miss. */
async function liveSetting(id: string): Promise<CheckInSettingRecord | null> {
  const record = await schedules().find("check-in-settings", id);
  return record && record.deletedAt === null ? record : null;
}

type History = {
  "check-in-runs": CheckInRunRecord;
  "check-in-suggestions": CheckInSuggestionRecord;
};

/**
 * Change one setting, reading it again and redoing the change whenever another writer changed it
 * first (the sweep moving its clock, a check-in recording how it went, the person on another tab).
 * `change` answers the fields to write from the setting as it stands, or null to write nothing. Null
 * when the setting is gone.
 */
async function changeSetting(
  id: string,
  change: (
    current: CheckInSettingRecord,
  ) => ScheduleChanges<"check-in-settings"> | null,
): Promise<CheckInSettingRecord | null> {
  for (let attempt = 0; attempt < VERSION_TRIES; attempt += 1) {
    const current =
      attempt === 0
        ? await liveSetting(id)
        : await schedules().refresh("check-in-settings", id);
    if (!current || current.deletedAt !== null) return null;
    const changes = change(current);
    if (!changes) return current;
    try {
      return await schedules().update(
        "check-in-settings",
        id,
        current.version,
        changes,
      );
    } catch (error) {
      if (error instanceof ScheduleVersionConflictError) continue;
      if (
        error instanceof ScheduleNotFoundError ||
        error instanceof ScheduleDeletedError
      )
        return null;
      throw error;
    }
  }
  throw new ScheduleVersionConflictError("check-in-settings", id);
}

/**
 * Change one record of the history the same way: read it from Intelligence, decide, write under its
 * version, and again when it moved in between. Null when it is gone or `change` declines.
 */
async function changeRecord<C extends keyof History>(
  collection: C,
  id: string,
  change: (current: History[C]) => ScheduleChanges<C> | null,
): Promise<History[C] | null> {
  const { client } = schedules();
  for (let attempt = 0; attempt < VERSION_TRIES; attempt += 1) {
    const current = (await client.get(collection, id)) as History[C] | null;
    if (!current) return null;
    const changes = change(current);
    if (!changes) return null;
    try {
      return (await client.update(
        collection,
        id,
        current.version,
        changes,
      )) as History[C];
    } catch (error) {
      if (error instanceof ScheduleVersionConflictError) continue;
      if (error instanceof ScheduleNotFoundError) return null;
      throw error;
    }
  }
  throw new ScheduleVersionConflictError(collection, id);
}

/** The newest first of a list, by when each was resolved. */
const byResolvedDesc = (items: CheckInSuggestionRecord[]) =>
  [...items].sort(
    (left, right) =>
      (right.resolvedAt?.getTime() ?? 0) - (left.resolvedAt?.getTime() ?? 0),
  );

/**
 * Open a new item. Its normalized title goes in `dedupeKey`, so when two check-ins race to open the
 * same thing for one person and Bot, Intelligence's unique rule on open titles lets one in and the
 * other is refused here as the repeat it is.
 */
async function insertSuggestion(
  input: NewSuggestion,
): Promise<ProactiveSuggestion> {
  try {
    return suggestionOf(
      await schedules().client.create("check-in-suggestions", {
        id: randomUUID(),
        ...input,
        status: "open",
        dedupeKey: titleKey(input.title),
        pingId: null,
        deliveredAt: null,
        resolvedAt: null,
      }),
    );
  } catch (error) {
    if (error instanceof ScheduleConflictError)
      throw new ProactiveRefusedError(
        "This is already raised and still open. Do not raise it again.",
      );
    throw error;
  }
}

/** The person's open items from every one of their Bots, newest first. */
async function openItemsOf(owner: string): Promise<PriorItems["open"]> {
  const { items } = await schedules().client.page(
    "check-in-suggestions",
    { ownerUserId: owner, status: "open" },
    null,
    PRIOR_LIMIT,
  );
  return items.map(({ id, agentId, title, sourceLink }) => ({
    id,
    agentId,
    title,
    sourceLink,
  }));
}

/**
 * What this person had (see {@link PriorItems}). Read fresh from Intelligence for each item a
 * check-in raises, under the person's lease when it is about to write, so an item any of their Bots
 * opened a moment ago counts too.
 */
async function priorItemsOf(
  database: Database,
  owner: string,
  agentId: string,
): Promise<PriorItems> {
  const since = new Date(Date.now() - HIDDEN_DAYS * 86_400_000);
  const { client } = schedules();
  const [open, hidden, started, tasks] = await Promise.all([
    openItemsOf(owner),
    client.all("check-in-suggestions", {
      ownerUserId: owner,
      status: "dismissed",
      resolvedAfter: since,
    }),
    client.all("check-in-suggestions", {
      ownerUserId: owner,
      agentId,
      status: "started",
      resolvedAfter: since,
    }),
    database
      .select({
        agentId: botTasks.agentId,
        title: botTasks.title,
        sourceLink: botTasks.sourceLink,
      })
      .from(botTasks)
      .where(and(eq(botTasks.ownerUserId, owner), isNull(botTasks.resolvedAt)))
      .orderBy(sql`${botTasks.createdAt} desc`)
      .limit(PRIOR_LIMIT),
  ]);
  return {
    open,
    tasks,
    hidden: byResolvedDesc(hidden.items)
      .slice(0, PRIOR_LIMIT)
      .map(({ agentId, title, sourceLink, sourceApp }) => ({
        agentId,
        title,
        sourceLink,
        sourceApp,
      })),
    started: byResolvedDesc(started.items)
      .slice(0, 20)
      .map(({ title }) => ({ title })),
  };
}

/**
 * The settings, of those asked about, whose person turned check-ins off for all their Bots or paused
 * this one: this deployment's own switches, read here and joined in code.
 */
async function switchedOff(
  database: Database,
  settings: readonly Pick<
    CheckInSettingRecord,
    "id" | "ownerUserId" | "agentId"
  >[],
): Promise<Set<string>> {
  if (settings.length === 0) return new Set();
  const owners = [...new Set(settings.map((setting) => setting.ownerUserId))];
  const off = new Set(
    (
      await database
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(users.id, owners),
            sql`${users.preferences}->>'proactive' = 'off'`,
          ),
        )
    ).map((row) => row.id),
  );
  const paused = new Set(
    (
      await database
        .select({
          ownerUserId: botLifecycle.ownerUserId,
          agentId: botLifecycle.agentId,
        })
        .from(botLifecycle)
        .where(
          and(
            inArray(botLifecycle.ownerUserId, owners),
            isNotNull(botLifecycle.pausedAt),
          ),
        )
    ).map((row) => `${row.ownerUserId}\u001f${row.agentId}`),
  );
  return new Set(
    settings
      .filter(
        (setting) =>
          off.has(setting.ownerUserId) ||
          paused.has(`${setting.ownerUserId}\u001f${setting.agentId}`),
      )
      .map((setting) => setting.id),
  );
}

/** A new item as a check-in raises it. Its id, status and normalized title are the store's. */
export type NewSuggestion = Omit<
  ProactiveSuggestion,
  | "id"
  | "status"
  | "dedupeKey"
  | "pingId"
  | "deliveredAt"
  | "resolvedAt"
  | "createdAt"
>;

export function createProactiveStore(database: Database) {
  async function get(owner: string, id: string): Promise<ProactiveSetting> {
    const record = await liveSetting(id);
    if (!record || record.ownerUserId !== owner)
      throw new ProactiveNotFoundError();
    return settingOf(record);
  }
  /** Intelligence itself, for the history, which no instance holds in memory. */
  const client = () => schedules().client;
  return {
    get,
    /** The person's hourly ping slot and the pings it lets through (`ping.ts`). */
    pings: createPingStore(database),
    /** This person's setting for this Bot, if they have one: there is at most one. */
    async forBot(
      owner: string,
      agentId: string,
    ): Promise<ProactiveSetting | null> {
      const record = schedules()
        .live("check-in-settings")
        .find(
          (setting) =>
            setting.ownerUserId === owner && setting.agentId === agentId,
        );
      return record ? settingOf(record) : null;
    },
    /** The setting as Intelligence has it now, not as this instance last heard: a check-in is about to run on it. */
    async byId(id: string): Promise<ProactiveSetting | null> {
      const record = await schedules().refresh("check-in-settings", id);
      return record && record.deletedAt === null ? settingOf(record) : null;
    },
    async list(owner: string): Promise<ProactiveSetting[]> {
      return schedules()
        .live("check-in-settings")
        .filter((setting) => setting.ownerUserId === owner)
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            (right.id < left.id ? -1 : 1),
        )
        .map(settingOf);
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
      try {
        return settingOf(
          await schedules().create("check-in-settings", {
            id: randomUUID(),
            ownerUserId: owner,
            threadId,
            ...parsed,
            nextRunAt: new Date(Date.now() + parsed.intervalMinutes * 60_000),
            lastRunAt: null,
            lastStatus: "idle",
            lastError: null,
          }),
        );
      } catch (error) {
        // Intelligence keeps one live setting per person and Bot.
        if (error instanceof ScheduleConflictError)
          throw new ProactiveRefusedError(
            "Check-ins are already set up for this Bot.",
          );
        throw error;
      }
    },
    /**
     * Change only what was sent. Off stays off until the person turns it on, whatever else they
     * change, and nothing here starts a check-in: Run now does that, behind its own gap.
     *
     * When the next check-in is due follows from the change, decided against the setting as it
     * stands and written under its version: turned on from off, one interval out (the interval sent,
     * or the one it has); a new interval while on, no later than one new interval out, so going from
     * daily to hourly is felt within the hour; anything else, as it was.
     */
    async update(owner: string, id: string, input: unknown) {
      const patch = parseWith(proactiveSettingPatchSchema, input);
      const known = await liveSetting(id);
      if (!known || known.ownerUserId !== owner)
        throw new ProactiveNotFoundError();
      const changed = await changeSetting(id, (current) => {
        const minutes = patch.intervalMinutes ?? current.intervalMinutes;
        const oneIntervalOut = new Date(Date.now() + minutes * 60_000);
        const kept =
          patch.intervalMinutes === undefined ||
          current.nextRunAt <= oneIntervalOut
            ? current.nextRunAt
            : oneIntervalOut;
        return {
          ...patch,
          nextRunAt:
            patch.enabled === true && !current.enabled ? oneIntervalOut : kept,
        };
      });
      if (!changed) throw new ProactiveNotFoundError();
      return settingOf(changed);
    },
    /**
     * Removing research is turning it down for this Bot: OpenBot never switches it back on. The
     * setting goes for good, its run ledger and its items with it, as the row and its cascade did.
     * Under the lease adoption takes (`memory/defaults.ts`), and the "no" is written first, so a
     * removal and an adoption arriving together never leave the setting made again.
     */
    async remove(owner: string, id: string) {
      const { agentId } = await get(owner, id);
      await withResearchDefaultsLock(database, owner, agentId, async () => {
        const current = await schedules().refresh("check-in-settings", id);
        if (
          !current ||
          current.deletedAt !== null ||
          current.ownerUserId !== owner
        )
          throw new ProactiveNotFoundError();
        await recordOptOut(database, {
          ownerUserId: owner,
          agentId,
          feature: "proactive_research",
        });
        await schedules().purge("check-in-settings", id);
      });
    },
    /**
     * Take the due settings and move each one's next run forward, one interval from now. The move is
     * Intelligence's compare-and-set on the clock this instance read, so two sweeps on two replicas
     * can never both take one, and the interval holds even when a run then fails. A clock another
     * replica already moved answers null, and the directory reads that setting again.
     *
     * Due is read from memory, then narrowed by this deployment's own switches: a person who turned
     * check-ins off for all their Bots or paused this one is not claimed, and so costs not even a
     * ledger record, every hour. The run checks both again before the model.
     */
    async claimDue(limit = 5): Promise<ProactiveSetting[]> {
      const at = new Date();
      const due = schedules()
        .live("check-in-settings")
        .filter((setting) => setting.enabled && setting.nextRunAt <= at)
        .sort(
          (left, right) => left.nextRunAt.getTime() - right.nextRunAt.getTime(),
        );
      if (due.length === 0) return [];
      const off = await switchedOff(database, due);
      const claimed: ProactiveSetting[] = [];
      for (const setting of due
        .filter((candidate) => !off.has(candidate.id))
        .slice(0, Math.min(limit, 10))) {
        const moved = await schedules().advance(
          "check-in-settings",
          setting.id,
          setting.nextRunAt,
          new Date(Date.now() + setting.intervalMinutes * 60_000),
        );
        if (moved) claimed.push(settingOf(moved));
      }
      return claimed;
    },
    async recordRun(
      id: string,
      status: ProactiveRunStatus,
      error: string | null = null,
    ) {
      await changeSetting(id, () => ({
        lastStatus: status,
        lastError: error?.slice(0, 500) ?? null,
        ...(status === "running" ? { lastRunAt: new Date() } : {}),
      }));
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
    /**
     * The tools this proactive run called that failed: the app could not be reached, refused the
     * account, or answered with an error. From the audit trail, as `readsFor` is. A call this
     * deployment refused before it left (a write a check-in may not make) is not one of them.
     */
    async failedReadsFor(runId: string): Promise<string[]> {
      const rows = await database
        .selectDistinct({ ref: auditEvents.targetId })
        .from(auditEvents)
        .where(
          and(
            eq(
              auditEvents.initiatorId,
              `${PROACTIVE_INITIATOR_PREFIX}${runId}`,
            ),
            eq(auditEvents.eventType, "mcp.call_failed"),
            gte(auditEvents.createdAt, new Date(Date.now() - 86_400_000)),
          ),
        )
        .limit(200);
      return rows.flatMap((row) => (row.ref ? [row.ref] : []));
    },
    async countSuggestions(runId: string) {
      return (await client().all("check-in-suggestions", { runId })).items
        .length;
    },
    /**
     * Open a new item as it is, with only Intelligence's unique rule (see {@link insertSuggestion}).
     * A check-in raises through `raise`, which refuses a repeat from any of the person's Bots first.
     */
    async addSuggestion(input: NewSuggestion): Promise<ProactiveSuggestion> {
      return insertSuggestion(input);
    },
    /**
     * What this person had: items still open, unfinished tasks and what they hid in the last thirty
     * days, from every one of their Bots, and what they started from this Bot. Newest first.
     */
    priorItems: (owner: string, agentId: string) =>
      priorItemsOf(database, owner, agentId),
    /**
     * Open a new item a check-in raised, unless `refuse` finds it repeats something the person
     * already has (it gets what {@link priorItemsOf} reads, and answers why, or null).
     *
     * The read and the write run under one lease per person. Their Bots check in on their own
     * schedules, on any replica, and two of them often find the same request at once; without the
     * lease both would read before either wrote, and the person would be told twice. Intelligence's
     * rule on open titles is per Bot, so for a second Bot this lease is the only thing that holds.
     */
    async raise(
      input: NewSuggestion,
      refuse: (prior: PriorItems) => string | null,
    ): Promise<ProactiveSuggestion> {
      return withLocalLock(database, itemsLock(input.ownerUserId), async () => {
        const repeat = refuse(
          await priorItemsOf(database, input.ownerUserId, input.agentId),
        );
        if (repeat) throw new ProactiveRefusedError(repeat);
        return insertSuggestion(input);
      });
    },
    /**
     * A check-in clearing one of its Bot's open items as no longer needed. Only an open item of this
     * setting: a Bot cannot clear another Bot's, another person's, or one the person already decided.
     */
    async clearSuggestion(
      settingId: string,
      id: string,
    ): Promise<ProactiveSuggestion | null> {
      const cleared = await changeRecord("check-in-suggestions", id, (item) =>
        item.settingId === settingId && item.status === "open"
          ? { status: "superseded" as const, resolvedAt: new Date() }
          : null,
      );
      return cleared ? suggestionOf(cleared) : null;
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
     * The run ledger (`check-in-runs` in Intelligence).
     * ------------------------------------------------------------------------------------------ */

    /**
     * Close check-ins left running past their lease as failed: the replica running them stopped. A
     * turn is cut off at three minutes, so a record still running at ten belongs to nobody, and the
     * one running record a setting may have must not block it for ever. Each is closed under the
     * version it was read at, so one its own replica finished meanwhile keeps how it finished.
     */
    async closeStaleRuns(leaseMs: number): Promise<number> {
      const { items } = await client().all("check-in-runs", {
        outcome: "running",
        startedBefore: new Date(Date.now() - leaseMs),
      });
      let closed = 0;
      for (const run of items) {
        try {
          await client().update("check-in-runs", run.id, run.version, {
            outcome: "failed",
            error: STOPPED_BEFORE_FINISHING,
            finishedAt: new Date(),
          });
          closed += 1;
        } catch (error) {
          if (
            error instanceof ScheduleVersionConflictError ||
            error instanceof ScheduleNotFoundError
          )
            continue;
          throw error;
        }
      }
      return closed;
    },
    /** A check-in a gate stopped before the model, and why. */
    async skipRun(input: {
      id: string;
      setting: Pick<ProactiveSetting, "id" | "ownerUserId" | "agentId">;
      trigger: ProactiveRunTrigger;
      reason: ProactiveSkipReason;
    }) {
      const at = new Date();
      try {
        await client().create(
          "check-in-runs",
          {
            id: input.id,
            settingId: input.setting.id,
            ownerUserId: input.setting.ownerUserId,
            agentId: input.setting.agentId,
            threadId: null,
            trigger: input.trigger,
            outcome: "skipped",
            skipReason: input.reason,
            itemsRaised: 0,
            reads: 0,
            error: null,
            startedAt: at,
            finishedAt: at,
          },
          `openbot:check-in-run:skip:${input.id}`,
        );
      } catch (error) {
        // Already recorded under this id: this is that skip, sent again.
        if (!(error instanceof ScheduleAlreadyExistsError)) throw error;
      }
    },
    /**
     * Start a check-in: its `running` record. False when another is already running for this
     * setting, on any replica, which Intelligence's one-running rule decides.
     */
    async beginRun(input: {
      id: string;
      setting: Pick<ProactiveSetting, "id" | "ownerUserId" | "agentId">;
      trigger: ProactiveRunTrigger;
      threadId: string;
    }): Promise<boolean> {
      try {
        await client().create(
          "check-in-runs",
          {
            id: input.id,
            settingId: input.setting.id,
            ownerUserId: input.setting.ownerUserId,
            agentId: input.setting.agentId,
            threadId: input.threadId,
            trigger: input.trigger,
            outcome: "running",
            skipReason: null,
            itemsRaised: 0,
            reads: 0,
            error: null,
            startedAt: new Date(),
            finishedAt: null,
          },
          `openbot:check-in-run:begin:${input.id}`,
        );
        return true;
      } catch (error) {
        if (error instanceof ScheduleConflictError) return false;
        // This run's own record, from a try whose answer was lost: run ids are new for every run.
        if (error instanceof ScheduleAlreadyExistsError) return true;
        throw error;
      }
    },
    /**
     * End a running check-in, once. A record the lease sweep already closed stays as it was closed.
     * `error` on a raised one says an app couldn't be read (`unreachedError`); a quiet one never has
     * one.
     */
    async finishRun(
      id: string,
      result: {
        outcome: "quiet" | "raised" | "failed";
        itemsRaised: number;
        reads: number;
        error?: string | null;
      },
    ) {
      await changeRecord("check-in-runs", id, (run) =>
        run.outcome === "running"
          ? {
              outcome: result.outcome,
              itemsRaised: result.itemsRaised,
              reads: result.reads,
              error: result.error?.slice(0, 500) ?? null,
              finishedAt: new Date(),
            }
          : null,
      );
    },
    /**
     * Where the setting's next check-in's window opens: the start of its last check-in that read
     * everything it tried to. That is a quiet one, or one that raised something with no app left
     * unread (`unreachedError`). A failed one never counts, so anything that arrived while an app
     * was down, or a run broke off, is read by the next one that can. Null when there is none.
     */
    async windowStart(settingId: string): Promise<Date | null> {
      let cursor: string | null = null;
      do {
        const page: SchedulePage<"check-in-runs"> = await client().page(
          "check-in-runs",
          { settingId, outcome: ["quiet", "raised"] },
          cursor,
          50,
        );
        const read = page.items.find((run) => run.error === null);
        if (read) return read.startedAt;
        cursor = page.nextCursor;
      } while (cursor);
      return null;
    },
    /** The setting's last check-in that reached the model and ended, for Run now's ten minutes. */
    async lastCheckIn(settingId: string): Promise<LastCheckIn | null> {
      const [run] = (
        await client().page(
          "check-in-runs",
          { settingId, outcome: ["quiet", "raised", "failed"] },
          null,
          1,
        )
      ).items;
      return run
        ? {
            outcome: run.outcome as LastCheckIn["outcome"],
            startedAt: run.startedAt,
          }
        : null;
    },
    /** The setting's newest check-in of any outcome, skipped and running ones included. */
    async latestRun(settingId: string): Promise<ProactiveRunRow | null> {
      const [run] = (
        await client().page("check-in-runs", { settingId }, null, 1)
      ).items;
      return run ? runOf(run) : null;
    },
    /**
     * Each of this person's settings' newest check-in, by setting: what their Bots' check-ins say
     * happened last, a skip and its reason included.
     */
    async latestRuns(owner: string): Promise<Map<string, ProactiveRunRow>> {
      const settings = schedules()
        .live("check-in-settings")
        .filter((setting) => setting.ownerUserId === owner);
      const newest = await Promise.all(
        settings.map(
          async (setting) =>
            (
              await client().page(
                "check-in-runs",
                { settingId: setting.id },
                null,
                1,
              )
            ).items[0],
        ),
      );
      return new Map(
        newest.flatMap((run) => (run ? [[run.settingId, runOf(run)]] : [])),
      );
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
      return (
        await client().all("check-in-runs", {
          settingId,
          outcome: ["running", "quiet", "raised", "failed"],
          startedAfter: new Date(Date.now() - 86_400_000),
        })
      ).items.length;
    },
    /**
     * Drop what the ledger no longer needs, older than `days`: finished check-ins, and pings no open
     * item still names. An open item's ping is what keeps it from being pinged again, so that ping
     * stays as long as the item does, and so does each person's newest ping, which the app notifies
     * on. Intelligence removes them in bounded batches. Returns how many of each went.
     */
    async prune(
      days = PROACTIVE_LEDGER_DAYS,
    ): Promise<{ runs: number; pings: number }> {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const runs = await client().prune("check-in-runs", cutoff);
      const pings = await client().prune("check-in-pings", cutoff);
      return { runs, pings };
    },
    /** A setting's recent check-ins, newest first, skipped ones included. */
    async runs(settingId: string): Promise<ProactiveRunRow[]> {
      return (
        await client().page("check-in-runs", { settingId }, null, 50)
      ).items.map(runOf);
    },
    async suggestions(owner: string): Promise<ProactiveSuggestion[]> {
      return (
        await client().page(
          "check-in-suggestions",
          { ownerUserId: owner, status: "open" },
          null,
          100,
        )
      ).items.map(suggestionOf);
    },
    async suggestion(owner: string, id: string): Promise<ProactiveSuggestion> {
      const item = await client().get("check-in-suggestions", id);
      if (!item || item.ownerUserId !== owner)
        throw new ProactiveNotFoundError();
      return suggestionOf(item);
    },
    /**
     * Open to dismissed or started, once. A second click is refused rather than run twice: the
     * change is written under the version it was read at, so of two at once only one lands.
     */
    async resolveSuggestion(
      owner: string,
      id: string,
      status: "dismissed" | "started",
    ): Promise<ProactiveSuggestion> {
      const resolved = await changeRecord("check-in-suggestions", id, (item) =>
        item.ownerUserId === owner && item.status === "open"
          ? { status, resolvedAt: new Date() }
          : null,
      );
      if (!resolved)
        throw new ProactiveRefusedError(
          "This suggestion was already started or dismissed.",
        );
      return suggestionOf(resolved);
    },
    /**
     * Back to open, after a Start whose task could not be opened, so the person can press it again.
     * Left started when any of their Bots raised the same thing again meanwhile: that new item is
     * the open one. Under the person's lease, so a check-in raising it now waits and finds this one.
     */
    async reopenSuggestion(owner: string, id: string) {
      await withLocalLock(database, itemsLock(owner), async () => {
        const open = await openItemsOf(owner);
        try {
          await changeRecord("check-in-suggestions", id, (item) =>
            item.ownerUserId === owner &&
            item.status === "started" &&
            !open.some((other) => sameThing(other, item))
              ? { status: "open" as const, resolvedAt: null }
              : null,
          );
        } catch (error) {
          // Opened again meanwhile under the same title for this Bot: that one is the open one.
          if (!(error instanceof ScheduleConflictError)) throw error;
        }
      });
    },
  };
}
export type ProactiveStore = ReturnType<typeof createProactiveStore>;

/**
 * Reset a person's check-ins with one Bot (`agents/lifecycle-reset.ts`): the settings go for good,
 * their runs and items with them, and any check-in already queued for one is cancelled. One they had
 * turned off is recorded as turned down first, so starting fresh never switches it back on. Under the
 * lease adoption takes. Returns how many settings went.
 */
export async function resetCheckInsOf(
  database: Database,
  ownerUserId: string,
  agentId: string,
): Promise<number> {
  return withResearchDefaultsLock(database, ownerUserId, agentId, async () => {
    const { items: settings } = await schedules().client.all(
      "check-in-settings",
      { ownerUserId, agentId },
    );
    if (settings.length === 0) return 0;
    if (settings.some((setting) => !setting.enabled))
      await recordOptOut(database, {
        ownerUserId,
        agentId,
        feature: "proactive_research",
      });
    const ids = settings.map((setting) => setting.id);
    // A run already queued for the setting would find it gone; cancel it rather than fail it.
    await database
      .update(workItems)
      .set({
        finishedAt: sql`now()`,
        claimedBy: null,
        leaseUntil: null,
        lastError: "Cancelled by reset",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workItems.kind, PROACTIVE_RUN_KIND),
          isNull(workItems.finishedAt),
          inArray(sql<string>`${workItems.payload}->>'settingId'`, ids),
        ),
      );
    for (const id of ids) await schedules().purge("check-in-settings", id);
    return ids.length;
  });
}

/** How many check-in settings this person has with this Bot, from memory: what a reset would remove. */
export function checkInsOf(ownerUserId: string, agentId: string): number {
  return schedules()
    .live("check-in-settings")
    .filter(
      (setting) =>
        setting.ownerUserId === ownerUserId && setting.agentId === agentId,
    ).length;
}
