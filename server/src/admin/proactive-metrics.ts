/**
 * The admin's numbers for check-ins (Admin, Check-ins): per Bot, over the last 7 or 30 days, how its
 * check-ins ended, what they raised, what people did with it, and how many pings carried it.
 *
 * COUNTS ONLY. An item's title comes from somebody's mail, and who was checked on is not an admin's
 * to read here, so nothing this answers carries a title, a why, a source or a person. Every query
 * groups by Bot; the people behind a count are read only to decide whether their check-ins are on.
 *
 * WHICH ITEMS. The items a Bot raised in the window, by where each stands now: still open, started,
 * hidden, or cleared by the Bot as no longer needed. Raised is therefore the sum of the other four,
 * and an item raised on the window's first day and started yesterday counts as started.
 *
 * ACCEPTANCE is started ÷ (started + hidden): of the items people decided on, how many they acted
 * on. An item nobody has answered yet, or one the Bot cleared itself, says nothing about whether the
 * Bot raised the right thing, so neither is in it. Null until somebody decided one.
 *
 * Runs come from the run ledger (`proactive_runs`), which keeps 30 days, so the longer window is
 * the whole ledger.
 */
import { and, count, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  botLifecycle,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
  users,
} from "../db/schema";
import type {
  BotProactiveMetrics,
  ProactiveMetricsResponse,
  ProactiveSkipReason,
} from "../proactive/contracts";
import { type CapabilityRow, resolveCapability } from "./capabilities";

/** The two windows the page offers. */
export const METRICS_DAYS = [7, 30] as const;
export type MetricsDays = (typeof METRICS_DAYS)[number];

export const METRICS_DAYS_ERROR = 'Query parameter "days" must be 7 or 30.';

/** `?days=`: 7 when absent, 7 or 30 when given, anything else refused. */
export function parseMetricsDays(
  raw: string | null,
): { ok: true; days: MetricsDays } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, days: 7 };
  const days = METRICS_DAYS.find((option) => String(option) === raw.trim());
  return days ? { ok: true, days } : { ok: false, error: METRICS_DAYS_ERROR };
}

const SKIP_REASONS: ProactiveSkipReason[] = [
  "off_admin",
  "off_person",
  "paused",
  "capped",
  "unreachable",
  "no_sources",
  "busy",
];

/** A Bot with nothing counted yet. Its picture is drawn from its id when it has no profile. */
function emptyBot(bot: {
  agentId: string;
  name: string;
  avatarSeed: string | null;
}): BotProactiveMetrics {
  return {
    agentId: bot.agentId,
    name: bot.name,
    avatarSeed: bot.avatarSeed ?? bot.agentId,
    peopleOn: 0,
    runs: {
      quiet: 0,
      raised: 0,
      failed: 0,
      skipped: Object.fromEntries(
        SKIP_REASONS.map((reason) => [reason, 0]),
      ) as Record<ProactiveSkipReason, number>,
    },
    items: { raised: 0, started: 0, hidden: 0, cleared: 0, open: 0 },
    acceptance: null,
    pinged: 0,
  };
}

export async function proactiveMetrics(
  database: Database,
  input: {
    days: MetricsDays;
    /** The daily cap in force, as the page shows it. */
    dailyRuns: number;
    /** The capability rows and the admins, to decide whose check-ins an admin left on. */
    capabilityRows: readonly CapabilityRow[];
    admins: ReadonlySet<string>;
  },
): Promise<ProactiveMetricsResponse> {
  const since = sql`now() - make_interval(days => ${input.days})`;

  /*
   * Every Bot anybody has check-ins for, on or off. A setting goes with its Bot, and the runs and
   * items go with their setting, so this is every Bot with a number to show. One after another, not
   * Promise.all: see the note in controls.ts about concurrent statements on one connection.
   */
  const bots = await database
    .selectDistinct({
      agentId: proactiveSettings.agentId,
      name: agents.name,
      avatarSeed: agentProfiles.avatarSeed,
    })
    .from(proactiveSettings)
    .innerJoin(agents, eq(agents.id, proactiveSettings.agentId))
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id));
  const byBot = new Map(bots.map((bot) => [bot.agentId, emptyBot(bot)]));
  const agentIds = [...byBot.keys()];
  if (agentIds.length === 0)
    return {
      days: input.days,
      dailyRuns: input.dailyRuns,
      bots: [],
      pings: await pings(database, since),
    };

  /*
   * Who would be checked on now: the setting is on, the person hasn't turned check-ins off for all
   * their Bots or paused this one (the sweep's own claim, `proactive/store.ts`), and the admin's
   * switch is on for them, decided by the same rule every capability is.
   */
  const on = await database
    .select({
      agentId: proactiveSettings.agentId,
      ownerUserId: proactiveSettings.ownerUserId,
      groups: users.groups,
    })
    .from(proactiveSettings)
    .innerJoin(users, eq(users.id, proactiveSettings.ownerUserId))
    .where(
      and(
        eq(proactiveSettings.enabled, true),
        sql`coalesce(${users.preferences}->>'proactive', 'on') <> 'off'`,
        sql`not exists (select 1 from ${botLifecycle} where ${botLifecycle.ownerUserId} = ${proactiveSettings.ownerUserId} and ${botLifecycle.agentId} = ${proactiveSettings.agentId} and ${botLifecycle.pausedAt} is not null)`,
      ),
    );
  for (const row of on) {
    const member = {
      role: input.admins.has(row.ownerUserId)
        ? ("admin" as const)
        : ("user" as const),
      groups: row.groups,
    };
    const bot = byBot.get(row.agentId);
    if (
      bot &&
      resolveCapability(input.capabilityRows, member, "proactive").allowed
    )
      bot.peopleOn += 1;
  }

  // How the window's check-ins ended. One still running has not ended, so it is in none of them.
  const runs = await database
    .select({
      agentId: proactiveRuns.agentId,
      outcome: proactiveRuns.outcome,
      skipReason: proactiveRuns.skipReason,
      count: count(),
    })
    .from(proactiveRuns)
    .where(
      and(
        inArray(proactiveRuns.agentId, agentIds),
        ne(proactiveRuns.outcome, "running"),
        gt(proactiveRuns.startedAt, since),
      ),
    )
    .groupBy(
      proactiveRuns.agentId,
      proactiveRuns.outcome,
      proactiveRuns.skipReason,
    );
  for (const row of runs) {
    const bot = byBot.get(row.agentId);
    if (!bot) continue;
    if (row.outcome === "skipped") {
      if (row.skipReason) bot.runs.skipped[row.skipReason] += row.count;
    } else if (row.outcome !== "running") bot.runs[row.outcome] += row.count;
  }

  // The window's items, by where each stands now, and how many of them a ping carried.
  const items = await database
    .select({
      agentId: proactiveSuggestions.agentId,
      status: proactiveSuggestions.status,
      count: count(),
      pinged: sql<number>`count(*) filter (where ${proactiveSuggestions.deliveredAt} is not null)::int`,
    })
    .from(proactiveSuggestions)
    .where(
      and(
        inArray(proactiveSuggestions.agentId, agentIds),
        gt(proactiveSuggestions.createdAt, since),
      ),
    )
    .groupBy(proactiveSuggestions.agentId, proactiveSuggestions.status);
  for (const row of items) {
    const bot = byBot.get(row.agentId);
    if (!bot) continue;
    bot.items.raised += row.count;
    bot.pinged += row.pinged;
    if (row.status === "open") bot.items.open += row.count;
    else if (row.status === "started") bot.items.started += row.count;
    else if (row.status === "dismissed") bot.items.hidden += row.count;
    else bot.items.cleared += row.count;
  }

  for (const bot of byBot.values()) {
    const decided = bot.items.started + bot.items.hidden;
    bot.acceptance = decided === 0 ? null : bot.items.started / decided;
  }

  return {
    days: input.days,
    dailyRuns: input.dailyRuns,
    bots: [...byBot.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    pings: await pings(database, since),
  };
}

/**
 * Pings in the window, for everybody at once: one ping folds every Bot's items for a person, so it
 * belongs to no one Bot. Only pings delivery was offered: one written but not yet offered has not
 * reached anybody.
 */
async function pings(
  database: Database,
  since: ReturnType<typeof sql>,
): Promise<ProactiveMetricsResponse["pings"]> {
  const [row] = await database
    .select({
      sent: count(),
      items: sql<string | null>`avg(${proactivePings.itemCount})`,
    })
    .from(proactivePings)
    .where(
      and(
        gt(proactivePings.createdAt, since),
        sql`${proactivePings.offeredAt} is not null`,
      ),
    );
  return {
    sent: row?.sent ?? 0,
    itemsPerPing: row?.items == null ? null : Number(row.items),
  };
}
