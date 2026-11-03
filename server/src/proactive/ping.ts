/**
 * The ping: one message to a person that something needs them, at most once an hour, folding every
 * Bot's waiting items into it, each item named with its Bot.
 *
 * THE HOUR IS INTELLIGENCE'S. No replica holds it in memory. Taking the person's slot is one call,
 * `check-in-pings/take`, which in one transaction on Intelligence's side takes the slot only when it
 * is free, refuses when any item it names was started, hidden or carried by another ping meanwhile,
 * and writes the ping, its text and the items it carries. Two replicas finishing check-ins for one
 * person in the same second take the slot once. A replica that stops after that call leaves a ping
 * the next pass offers word for word (`unoffered`). Delivery's own dedupe keys, built from the ping's
 * id, stop a second send when it is offered twice.
 *
 * WHAT A PING CARRIES. Every open item of the person that no ping has carried, from any of their
 * Bots, as listed just before the slot is taken: an item started or hidden in between makes the take
 * refuse, and it is listed again once. Two kinds of item never hold the slot and are never pinged: a
 * Bot the person set to notify them of nothing (its items stay in the app list), and every item while
 * the person has check-ins turned off. Those two switches are this deployment's own, read here and
 * joined to Intelligence's list in code. A ping is a template filled from the items, never a model
 * turn.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bots } from "../agents/bot-registry/directory";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import { botLifecycle } from "../db/schema/lifecycle";
import {
  CheckInItemsChangedError,
  CheckInSlotTakenError,
  ScheduleNotFoundError,
  ScheduleVersionConflictError,
} from "../schedules/client";
import { schedules } from "../schedules/directory";
import type { CheckInSuggestionRecord } from "../schedules/types";
import type { AttentionItem, AttentionPing } from "./contracts";

/** The least time between two pings to one person. */
export const PING_GAP_MINUTES = 60;
/** How many items a ping's message lists before it says how many more there are. */
const LISTED = 5;
/** What a phone shows of a notification's body before it cuts it short. */
const PUSH_BODY_MAX = 200;

/** The first sentence of an item's why, so each item in a ping is one line. */
function firstSentence(detail: string): string {
  const paragraph = detail.split(/\n\s*\n/)[0]?.trim() ?? "";
  return (paragraph.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? paragraph).trim();
}

/** A title without a trailing full stop, as the push line lists titles. */
const bare = (title: string) => title.trim().replace(/[.\s]+$/, "");
/** A title as a sentence of its own in the message, ending in exactly one stop. */
const sentence = (title: string) =>
  /[!?]$/.test(bare(title)) ? bare(title) : `${bare(title)}.`;

/**
 * "One thing needs you", "3 things need you": the first line of a ping's message, and the title of
 * its push.
 */
export function pingHeadline(count: number) {
  return count === 1 ? "One thing needs you" : `${count} things need you`;
}

/**
 * Cut to at most `max` characters, counted by code point as the push transport counts them, so a
 * cut never splits one in half.
 */
function clip(text: string, max: number) {
  const characters = Array.from(text);
  return characters.length <= max
    ? text
    : `${characters
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/**
 * The folded message for Slack, Teams and SMS, and the body a push shows under its title
 * ({@link pingHeadline}). In the message each item is its Bot, its title, why (the first sentence of
 * it) and the app it came from; in the push, its Bot and title, one line each. Oldest first, so both
 * read as what has been waiting longest.
 */
export function pingText(items: readonly AttentionItem[]): {
  text: string;
  pushBody: string;
} {
  const lines = items.slice(0, LISTED).map((item) => {
    const why = firstSentence(item.why);
    return `• ${item.agentName}: ${sentence(item.title)}${why ? ` ${why}` : ""}${item.sourceApp ? ` (from ${item.sourceApp})` : ""}`;
  });
  const more = items.length - LISTED;
  const andMore = more > 0 ? [`and ${more} more`] : [];
  const text = [
    pingHeadline(items.length),
    ...lines,
    ...andMore,
    items.length === 1
      ? "Start or hide it in OpenBot."
      : "Start or hide them in OpenBot.",
  ].join("\n");
  const pushBody = clip(
    [
      ...items
        .slice(0, LISTED)
        .map((item) => `${item.agentName}: ${bare(item.title)}`),
      ...andMore,
    ].join("\n"),
    PUSH_BODY_MAX,
  );
  return { text, pushBody };
}

/** How many times one take is tried when an item it was to carry changed in between. */
const TAKE_TRIES = 2;

/**
 * The person's slot is free, as this instance last heard: never pinged, or the last ping an hour or
 * more ago. Intelligence decides for certain when the slot is taken; this only spares asking it for
 * a person plainly pinged within the hour.
 */
function slotFree(ownerUserId: string, at: number): boolean {
  const person = schedules().peek("check-in-people", ownerUserId);
  return (
    !person?.lastPingedAt ||
    person.lastPingedAt.getTime() <= at - PING_GAP_MINUTES * 60_000
  );
}

/** What a ping lists of an item. */
function itemOf(record: CheckInSuggestionRecord) {
  return {
    suggestionId: record.id,
    agentId: record.agentId,
    title: record.title,
    why: record.detail,
    sourceApp: record.sourceApp,
  };
}

/**
 * Each item with its Bot's name, from the Bot directory's memory. An item whose Bot Intelligence no
 * longer has is left out, as the join to `agents` left it out before.
 */
function named<Row extends { agentId: string }>(
  rows: Row[],
): (Row & { agentName: string })[] {
  return rows.flatMap((row) => {
    const bot = bots().peek(row.agentId);
    return bot ? [{ ...row, agentName: bot.name }] : [];
  });
}

export function createPingStore(database: Database) {
  /**
   * Items a ping may carry, oldest first: open, carried by no ping yet (from Intelligence), from a
   * Bot its person has not told to notify them of nothing, while they have check-ins on (here).
   */
  async function pingable(
    ownerUserId?: string,
  ): Promise<CheckInSuggestionRecord[]> {
    const { items } = await schedules().client.all("check-in-suggestions", {
      ...(ownerUserId ? { ownerUserId } : {}),
      status: "open",
      unpinged: true,
      order: "asc",
    });
    if (items.length === 0) return [];
    const owners = [...new Set(items.map((item) => item.ownerUserId))];
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
    const silenced = new Set(
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
              eq(botLifecycle.notify, "none"),
            ),
          )
      ).map((row) => `${row.ownerUserId}\u001f${row.agentId}`),
    );
    return items.filter(
      (item) =>
        !off.has(item.ownerUserId) &&
        !silenced.has(`${item.ownerUserId}\u001f${item.agentId}`),
    );
  }

  return {
    /**
     * Take the person's hourly slot and write one ping folding everything waiting for them. Null when
     * the slot is taken (another replica pinged them this hour) or nothing waits. Safe to call from
     * any number of replicas at once: exactly one of them gets the ping.
     */
    async take(ownerUserId: string): Promise<AttentionPing | null> {
      for (let attempt = 1; attempt <= TAKE_TRIES; attempt += 1) {
        if (!slotFree(ownerUserId, Date.now())) return null;
        const items = named((await pingable(ownerUserId)).map(itemOf));
        if (items.length === 0) return null;
        const pingId = randomUUID();
        const { text, pushBody } = pingText(items);
        try {
          await schedules().client.takePing({
            id: pingId,
            ownerUserId,
            gapMinutes: PING_GAP_MINUTES,
            suggestionIds: items.map((item) => item.suggestionId),
            text,
            pushBody,
          });
        } catch (error) {
          if (error instanceof CheckInSlotTakenError) {
            await schedules()
              .refresh("check-in-people", ownerUserId)
              .catch(() => null);
            return null;
          }
          // Started, hidden or carried meanwhile: list what waits again, once.
          if (error instanceof CheckInItemsChangedError) continue;
          throw error;
        }
        // This instance knows its own ping at once; every other one hears it announced.
        await schedules()
          .refresh("check-in-people", ownerUserId)
          .catch(() => null);
        return { pingId, ownerUserId, text, pushBody, items };
      }
      return null;
    },

    /**
     * People with something waiting and a free slot: who the ping pass tries. Oldest wait first, so
     * a backlog drains in the order it built up. `skip` is everyone the pass already tried, so it
     * can page past people it may not ping (`pingPass` in engine.ts).
     */
    async waiting(limit = 20, skip: readonly string[] = []): Promise<string[]> {
      const at = Date.now();
      const skipped = new Set(skip);
      const firstWaited = new Map<string, number>();
      for (const item of await pingable()) {
        if (skipped.has(item.ownerUserId) || !slotFree(item.ownerUserId, at))
          continue;
        const created = item.createdAt.getTime();
        const known = firstWaited.get(item.ownerUserId);
        if (known === undefined || created < known)
          firstWaited.set(item.ownerUserId, created);
      }
      return [...firstWaited]
        .sort((left, right) => left[1] - right[1])
        .slice(0, limit)
        .map(([ownerUserId]) => ownerUserId);
    },

    /**
     * Pings written but never offered to delivery, older than `olderThanMs`: a replica stopped
     * between the take and the offer. Rebuilt from the ping record, so the text is the one written.
     */
    async unoffered(olderThanMs: number, limit = 20): Promise<AttentionPing[]> {
      const at = Date.now();
      const { items: pings } = await schedules().client.page(
        "check-in-pings",
        {
          offered: false,
          createdBefore: new Date(at - olderThanMs),
          // A day late is no longer news: the items are on the person's list either way.
          createdAfter: new Date(at - 86_400_000),
        },
        null,
        limit,
      );
      if (pings.length === 0) return [];
      const items: (ReturnType<typeof itemOf> & { pingId: string | null })[] =
        [];
      for (let start = 0; start < pings.length; start += 200) {
        const { items: carried } = await schedules().client.all(
          "check-in-suggestions",
          {
            pingId: pings.slice(start, start + 200).map((ping) => ping.id),
            order: "asc",
          },
        );
        items.push(
          ...carried.map((item) => ({ ...itemOf(item), pingId: item.pingId })),
        );
      }
      const listed = named(items);
      return pings.map((ping) => ({
        pingId: ping.id,
        ownerUserId: ping.ownerUserId,
        text: ping.text,
        pushBody: ping.pushBody,
        items: listed
          .filter((item) => item.pingId === ping.id)
          .map(({ pingId: _, ...item }) => item),
      }));
    },

    /** Delivery rows were offered for this ping. Once: one already marked stays as it was. */
    async markOffered(pingId: string) {
      const { client } = schedules();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const ping = await client.get("check-in-pings", pingId);
        if (!ping || ping.offeredAt) return;
        try {
          await client.update("check-in-pings", pingId, ping.version, {
            offeredAt: new Date(),
          });
          return;
        } catch (error) {
          if (error instanceof ScheduleVersionConflictError) continue;
          if (error instanceof ScheduleNotFoundError) return;
          throw error;
        }
      }
    },
  };
}
export type PingStore = ReturnType<typeof createPingStore>;
