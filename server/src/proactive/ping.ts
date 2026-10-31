/**
 * The ping: one message to a person that something needs them, at most once an hour, folding every
 * Bot's waiting items into it, each item named with its Bot.
 *
 * ALL OF IT IS IN POSTGRES. No replica holds the hour in memory. Taking the person's slot is one
 * conditional UPDATE of `proactive_people.last_pinged_at`: the row lock serializes replicas, and
 * under read committed Postgres re-checks the condition against the row a winner just wrote, so two
 * replicas finishing check-ins for one person in the same second take the slot once. The ping row,
 * its text and the items it carries are written in the same transaction, so a replica that stops
 * after that commit leaves a ping the next pass offers word for word (`unoffered`). Delivery's own
 * dedupe keys, built from the ping's id, stop a second send when it is offered twice.
 *
 * WHAT A PING CARRIES. Every open item of the person that no ping has carried, from any of their
 * Bots, as of the moment the slot is taken: items started, hidden or cleared before then are not in
 * it. Two kinds of item never hold the slot and are never pinged: a Bot the person set to notify
 * them of nothing (its items stay in the app list), and every item while the person has check-ins
 * turned off. A ping is a template filled from the items, never a model turn.
 */
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, users } from "../db/schema/core";
import { botLifecycle } from "../db/schema/lifecycle";
import {
  proactivePeople,
  proactivePings,
  proactiveSuggestions,
} from "../db/schema/proactive";
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

/**
 * An item a ping may carry: open, carried by no ping yet, from a Bot its person has not told to
 * notify them of nothing, while they have check-ins on.
 */
const pingableItem = and(
  eq(proactiveSuggestions.status, "open"),
  isNull(proactiveSuggestions.pingId),
  sql`not exists (select 1 from ${botLifecycle} where ${botLifecycle.ownerUserId} = ${proactiveSuggestions.ownerUserId} and ${botLifecycle.agentId} = ${proactiveSuggestions.agentId} and ${botLifecycle.notify} = 'none')`,
  sql`not exists (select 1 from ${users} where ${users.id} = ${proactiveSuggestions.ownerUserId} and ${users.preferences}->>'proactive' = 'off')`,
);
const pingable = (ownerUserId: string) =>
  and(eq(proactiveSuggestions.ownerUserId, ownerUserId), pingableItem);

/** The person's slot is free: never pinged, or the last ping was an hour or more ago. */
const slotFree = or(
  isNull(proactivePeople.lastPingedAt),
  lte(
    proactivePeople.lastPingedAt,
    sql`now() - make_interval(mins => ${PING_GAP_MINUTES})`,
  ),
);

const itemColumns = {
  suggestionId: proactiveSuggestions.id,
  agentId: proactiveSuggestions.agentId,
  agentName: agents.name,
  title: proactiveSuggestions.title,
  why: proactiveSuggestions.detail,
  sourceApp: proactiveSuggestions.sourceApp,
};

export function createPingStore(database: Database) {
  return {
    /**
     * Take the person's hourly slot and write one ping folding everything waiting for them. Null when
     * the slot is taken (another replica pinged them this hour) or nothing waits. Safe to call from
     * any number of replicas at once: exactly one of them gets the ping.
     */
    async take(ownerUserId: string): Promise<AttentionPing | null> {
      // The person's row, made once. The slot is a lock on it, so it has to exist before the race.
      await database
        .insert(proactivePeople)
        .values({ ownerUserId })
        .onConflictDoNothing();
      try {
        return await database.transaction(async (transaction) => {
          const [slot] = await transaction
            .update(proactivePeople)
            .set({ lastPingedAt: sql`now()`, updatedAt: sql`now()` })
            .where(
              and(
                eq(proactivePeople.ownerUserId, ownerUserId),
                slotFree,
                sql`exists (select 1 from ${proactiveSuggestions} where ${pingable(ownerUserId)})`,
              ),
            )
            .returning({ ownerUserId: proactivePeople.ownerUserId });
          if (!slot) return null;
          /*
           * Locked, so a Start or Hide arriving now waits for this commit and then finds the item
           * still open: it was open when the ping was written, so the ping names it truthfully.
           */
          const items = await transaction
            .select(itemColumns)
            .from(proactiveSuggestions)
            .innerJoin(agents, eq(agents.id, proactiveSuggestions.agentId))
            .where(pingable(ownerUserId))
            .orderBy(
              asc(proactiveSuggestions.createdAt),
              asc(proactiveSuggestions.id),
            )
            .for("update", { of: proactiveSuggestions });
          // Everything waiting was started or hidden between the slot and here: give the slot back.
          if (items.length === 0) transaction.rollback();
          const pingId = randomUUID();
          const { text, pushBody } = pingText(items);
          await transaction.insert(proactivePings).values({
            id: pingId,
            ownerUserId,
            itemCount: items.length,
            text,
            pushBody,
          });
          await transaction
            .update(proactiveSuggestions)
            .set({ pingId, deliveredAt: sql`now()` })
            .where(
              inArray(
                proactiveSuggestions.id,
                items.map((item) => item.suggestionId),
              ),
            );
          return { pingId, ownerUserId, text, pushBody, items };
        });
      } catch (error) {
        if (error instanceof TransactionRollbackError) return null;
        throw error;
      }
    },

    /**
     * People with something waiting and a free slot: who the ping pass tries. Oldest wait first, so
     * a backlog drains in the order it built up.
     */
    async waiting(limit = 20): Promise<string[]> {
      const rows = await database
        .select({ ownerUserId: proactiveSuggestions.ownerUserId })
        .from(proactiveSuggestions)
        .leftJoin(
          proactivePeople,
          eq(proactivePeople.ownerUserId, proactiveSuggestions.ownerUserId),
        )
        .where(and(pingableItem, slotFree))
        .groupBy(proactiveSuggestions.ownerUserId)
        .orderBy(sql`min(${proactiveSuggestions.createdAt})`)
        .limit(limit);
      return rows.map((row) => row.ownerUserId);
    },

    /**
     * Pings written but never offered to delivery, older than `olderThanMs`: a replica stopped
     * between the commit and the offer. Rebuilt from the ping row, so the text is the one written.
     */
    async unoffered(olderThanMs: number, limit = 20): Promise<AttentionPing[]> {
      const pings = await database
        .select()
        .from(proactivePings)
        .where(
          and(
            isNull(proactivePings.offeredAt),
            lte(
              proactivePings.createdAt,
              sql`now() - make_interval(secs => ${olderThanMs / 1000})`,
            ),
            // A day late is no longer news: the items are on the person's list either way.
            gte(proactivePings.createdAt, sql`now() - interval '1 day'`),
          ),
        )
        .orderBy(asc(proactivePings.createdAt))
        .limit(limit);
      if (pings.length === 0) return [];
      const items = await database
        .select({ ...itemColumns, pingId: proactiveSuggestions.pingId })
        .from(proactiveSuggestions)
        .innerJoin(agents, eq(agents.id, proactiveSuggestions.agentId))
        .where(
          inArray(
            proactiveSuggestions.pingId,
            pings.map((ping) => ping.id),
          ),
        )
        .orderBy(
          asc(proactiveSuggestions.createdAt),
          asc(proactiveSuggestions.id),
        );
      return pings.map((ping) => ({
        pingId: ping.id,
        ownerUserId: ping.ownerUserId,
        text: ping.text,
        pushBody: ping.pushBody,
        items: items
          .filter((item) => item.pingId === ping.id)
          .map(({ pingId: _, ...item }) => item),
      }));
    },

    /** Delivery rows were offered for this ping. */
    async markOffered(pingId: string) {
      await database
        .update(proactivePings)
        .set({ offeredAt: sql`now()` })
        .where(
          and(eq(proactivePings.id, pingId), isNull(proactivePings.offeredAt)),
        );
    },
  };
}
export type PingStore = ReturnType<typeof createPingStore>;
