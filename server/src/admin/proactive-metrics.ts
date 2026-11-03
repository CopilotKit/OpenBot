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
 * Runs come from the run ledger (Intelligence's `check-in-runs`), which keeps 30 days, so the longer
 * window is the whole ledger. The counts are Intelligence's own summaries: the history is not read
 * here, only how many of each. The settings are held in memory (`schedules/directory.ts`); whose
 * check-ins are on is decided here from this deployment's own switches.
 */
import { and, inArray, isNotNull } from "drizzle-orm";
import { bots as directory } from "../agents/bot-registry/directory";
import type { Database } from "../db/client";
import { botLifecycle, users } from "../db/schema";
import { schedules } from "../schedules/directory";
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
  const since = new Date(Date.now() - input.days * 86_400_000);
  const settings = schedules().live("check-in-settings");

  /*
   * Every Bot anybody has check-ins for, on or off. A setting goes with its Bot, and the runs and
   * items go with their setting, so this is every Bot with a number to show.
   */
  const settingBots = [...new Set(settings.map((setting) => setting.agentId))];
  // A setting whose Bot Intelligence no longer has is left out, as the join to `agents` left it out.
  const known = await directory().findMany(settingBots);
  const byBot = new Map(
    settingBots.flatMap((agentId) => {
      const bot = known.get(agentId);
      return bot
        ? [
            [
              agentId,
              emptyBot({
                agentId,
                name: bot.name,
                avatarSeed: bot.avatarSeed,
              }),
            ] as const,
          ]
        : [];
    }),
  );
  const agentIds = [...byBot.keys()];
  if (agentIds.length === 0)
    return {
      days: input.days,
      dailyRuns: input.dailyRuns,
      bots: [],
      pings: await pings(since),
    };

  /*
   * Who would be checked on now: the setting is on, the person hasn't turned check-ins off for all
   * their Bots or paused this one (the sweep's own claim, `proactive/store.ts`), and the admin's
   * switch is on for them, decided by the same rule every capability is.
   */
  const enabled = settings.filter(
    (setting) => setting.enabled && byBot.has(setting.agentId),
  );
  const owners = [...new Set(enabled.map((setting) => setting.ownerUserId))];
  const people =
    owners.length === 0
      ? []
      : await database
          .select({
            id: users.id,
            groups: users.groups,
            preferences: users.preferences,
          })
          .from(users)
          .where(inArray(users.id, owners));
  const paused =
    owners.length === 0
      ? []
      : await database
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
          );
  const pausedPairs = new Set(
    paused.map((row) => `${row.ownerUserId}\u001f${row.agentId}`),
  );
  const personById = new Map(people.map((person) => [person.id, person]));
  for (const setting of enabled) {
    const person = personById.get(setting.ownerUserId);
    // As the join to `users` did: a setting whose person is gone counts for nobody.
    if (!person) continue;
    if (
      (person.preferences as { proactive?: unknown } | null)?.proactive ===
      "off"
    )
      continue;
    if (pausedPairs.has(`${setting.ownerUserId}\u001f${setting.agentId}`))
      continue;
    const member = {
      role: input.admins.has(setting.ownerUserId)
        ? ("admin" as const)
        : ("user" as const),
      groups: person.groups,
    };
    const bot = byBot.get(setting.agentId);
    if (
      bot &&
      resolveCapability(input.capabilityRows, member, "proactive").allowed
    )
      bot.peopleOn += 1;
  }

  // How the window's check-ins ended. One still running has not ended, so it is in none of them.
  for (const row of await schedules().client.checkInRunSummary(
    since,
    agentIds,
  )) {
    const bot = byBot.get(row.agentId);
    if (!bot) continue;
    if (row.outcome === "skipped") {
      const reason = row.skipReason as ProactiveSkipReason | null;
      if (reason && reason in bot.runs.skipped)
        bot.runs.skipped[reason] += row.runs;
    } else if (
      row.outcome === "quiet" ||
      row.outcome === "raised" ||
      row.outcome === "failed"
    )
      bot.runs[row.outcome] += row.runs;
  }

  // The window's items, by where each stands now, and how many of them a ping carried.
  for (const row of await schedules().client.checkInSuggestionSummary(
    since,
    agentIds,
  )) {
    const bot = byBot.get(row.agentId);
    if (!bot) continue;
    bot.items.raised += row.items;
    bot.pinged += row.delivered;
    if (row.status === "open") bot.items.open += row.items;
    else if (row.status === "started") bot.items.started += row.items;
    else if (row.status === "dismissed") bot.items.hidden += row.items;
    else bot.items.cleared += row.items;
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
    pings: await pings(since),
  };
}

/**
 * Pings in the window, for everybody at once: one ping folds every Bot's items for a person, so it
 * belongs to no one Bot. Only pings delivery was offered: one written but not yet offered has not
 * reached anybody.
 */
async function pings(since: Date): Promise<ProactiveMetricsResponse["pings"]> {
  const summary = await schedules().client.checkInPingSummary(since);
  return {
    sent: summary.pings,
    itemsPerPing: summary.itemsPerPing ?? null,
  };
}
