/**
 * A few words saying what a conversation is about, since a channel's name is only its Bots' names.
 *
 * Not a headless turn: `run-turn.ts` takes the thread lock, which would refuse the person's own next
 * message with 409 for the lock's TTL. `getThreadMessages` takes no lock, so this reads and asks.
 *
 * Offer then claim, like `work/culler.ts`. The offer is derived from the table rather than from an
 * event, so a missed sweep costs two seconds where a missed event would cost the name entirely.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import { CHANNEL_ACTIVITY_TOPIC, type ChannelActivityEvent } from "./events";
import { oneLine } from "./text";

export const CHANNEL_SUMMARY_KIND = "channel.summary";

/** A title long enough to truncate says no more than the preview it replaced. */
const MAX_SUMMARY_CODE_POINTS = 60;

/** How much of the opening exchange the model is shown. Enough to see the topic, not the whole run. */
const MAX_EXCERPT_CODE_POINTS = 600;

/** A seam, so a test drives every path with no key and no network. Null means nothing worth writing. */
export type ChannelTitler = (excerpt: string) => Promise<string | null>;

/** The one method of the Intelligence client this file uses. Narrowed for the same reason. */
export type ThreadTranscript = {
  getThreadMessages(params: { threadId: string; userId: string }): Promise<{
    messages: { role: string; content?: unknown }[];
  }>;
};

export type ChannelSummaryOptions = {
  database: Database;
  queue: WorkQueue;
  transcript: ThreadTranscript;
  title: ChannelTitler;
  /** Who this replica is, for the lease. */
  owner: string;
  leaseMs?: number;
  maxAttempts?: number;
  /** How many channels one pass will offer, and how many it will claim. */
  limit?: number;
};

export type SummaryReport = {
  considered: number;
  written: string[];
  skipped: { channelId: string; reason: string }[];
};

/**
 * Offer every conversation that has been spoken in and has no name yet.
 *
 * `channels_awaiting_summary_idx` keeps this off a full scan; `offer` is idempotent on (kind, key),
 * so every replica and every later pass collapse onto one row.
 */
export async function offerChannelsAwaitingSummary(
  options: Pick<ChannelSummaryOptions, "database" | "queue" | "limit">,
): Promise<{ offered: string[] }> {
  const rows = await options.database
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        isNull(channels.summary),
        isNull(channels.deletedAt),
        sql`${channels.lastMessageAt} is not null`,
      ),
    )
    .limit(options.limit ?? 20);

  const offered: string[] = [];
  for (const row of rows) {
    await options.queue.offer({
      kind: CHANNEL_SUMMARY_KIND,
      key: row.id,
      payload: { channelId: row.id },
    });
    offered.push(row.id);
  }
  return { offered };
}

/** Name what this replica can claim. The lease is renewed per item: a model call is not instant. */
export async function summariseClaimedChannels(
  options: ChannelSummaryOptions,
): Promise<SummaryReport> {
  const leaseMs = options.leaseMs ?? 60_000;
  const claimed = await options.queue.claim({
    kind: CHANNEL_SUMMARY_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? 5,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });

  const report: SummaryReport = {
    considered: claimed.length,
    written: [],
    skipped: [],
  };

  for (const item of claimed) {
    const channelId = String(item.payload.channelId ?? item.key);
    if (
      !(await options.queue.renew({
        kind: CHANNEL_SUMMARY_KIND,
        key: item.key,
        owner: options.owner,
        leaseMs,
      }))
    ) {
      report.skipped.push({
        channelId,
        reason: "the lease went to another replica",
      });
      continue;
    }

    try {
      const attempt = await summariseOne(options, channelId);
      if (attempt === "not yet") {
        // Put back, not finished: Intelligence has not persisted the message yet.
        await options.queue.release({
          kind: CHANNEL_SUMMARY_KIND,
          key: item.key,
          owner: options.owner,
          delayMs: 15_000,
          reason: "the conversation is not readable yet",
        });
        report.skipped.push({ channelId, reason: "not readable yet" });
        continue;
      }
      await options.queue.finish({
        kind: CHANNEL_SUMMARY_KIND,
        key: item.key,
        owner: options.owner,
      });
      if (attempt === "written") report.written.push(channelId);
      else report.skipped.push({ channelId, reason: attempt });
    } catch (error) {
      // Released and pushed out: a model that just refused will refuse again, and nothing is broken meanwhile.
      const reason =
        error instanceof Error ? error.message : "could not be summarised";
      await options.queue.release({
        kind: CHANNEL_SUMMARY_KIND,
        key: item.key,
        owner: options.owner,
        delayMs: 60_000,
        reason,
      });
      // Said out loud when it gives up, because at the cap this loop simply never sees the channel
      // again and every pass afterwards looks clean.
      if (item.attempts >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        console.warn(
          JSON.stringify({
            type: "channel-summary-gave-up",
            channelId,
            attempts: item.attempts,
            reason,
          }),
        );
      }
      report.skipped.push({ channelId, reason });
    }
  }

  return report;
}

/**
 * Three words, not a boolean, so `"not yet"` is told apart from the rest: a conversation offered the
 * instant somebody speaks may have no message in Intelligence yet, and finishing it never names it.
 */
type Attempt = "written" | "not yet" | "nothing to name it with";

async function summariseOne(
  options: ChannelSummaryOptions,
  channelId: string,
): Promise<Attempt> {
  /* A queue key is not a foreign key, so work outlives its channel. Gone is final, not not-yet. */
  const [existing] = await options.database
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!existing || existing.deletedAt !== null)
    return "nothing to name it with";

  /* Threads are per person, so the one read must be chosen: the earliest member opened it. */
  const [owner] = await options.database
    .select({
      userId: channelMemberships.userId,
      threadId: intelligenceChannelMappings.threadId,
    })
    .from(channelMemberships)
    .innerJoin(
      intelligenceChannelMappings,
      and(
        eq(intelligenceChannelMappings.channelId, channelMemberships.channelId),
        eq(intelligenceChannelMappings.userId, channelMemberships.userId),
      ),
    )
    .where(eq(channelMemberships.channelId, channelId))
    .orderBy(asc(channelMemberships.createdAt), asc(channelMemberships.userId))
    .limit(1);

  // No member holds a thread for this channel yet, so there is nothing to read — yet.
  if (!owner) return "not yet";

  const excerpt = await openingOf(options.transcript, owner);
  if (!excerpt) return "not yet";

  // Final, unlike the two above: no key or nothing usable does not change a minute later.
  const answer = await options.title(excerpt);
  if (!answer) return "nothing to name it with";

  const title = oneLine(stripWrappingQuotes(answer), MAX_SUMMARY_CODE_POINTS);
  if (!title) return "nothing to name it with";

  return await options.database.transaction<Attempt>(
    async (transaction) => {
      // Conditional, not check-then-write: a second replica changes no rows and announces nothing.
      const applied = await transaction
        .update(channels)
        .set({ summary: title, summaryAt: new Date(), updatedAt: new Date() })
        .where(and(eq(channels.id, channelId), isNull(channels.summary)))
        .returning({ id: channels.id });
      // Somebody else named it between the claim and this write. Their title stands, and this work
      // is done rather than still owed.
      if (applied.length === 0) return "written";

      const members = await transaction
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId));

      // Announced inside the transaction, so it is delivered on commit and a write that rolls back
      // is never announced — the rule every other writer in this area follows.
      const event: ChannelActivityEvent = {
        channelId,
        memberIds: members.map((member) => member.userId),
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        summary: title,
      };
      await transaction.execute(
        sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
      );
      return "written";
    },
    { isolationLevel: "read committed" },
  );
}

/* The opening exchange only: a conversation that wandered is still filed under what it opened for. */
async function openingOf(
  transcript: ThreadTranscript,
  owner: { threadId: string; userId: string },
): Promise<string | null> {
  const history = await transcript.getThreadMessages({
    threadId: owner.threadId,
    userId: owner.userId,
  });
  const question = history.messages.find((message) => message.role === "user");
  if (!question) return null;
  const answer = history.messages.find(
    (message) => message.role === "assistant",
  );

  const asked = textOf(question.content);
  if (!asked) return null;
  const replied = answer ? textOf(answer.content) : "";

  return oneLine(
    replied ? `Asked: ${asked}\nAnswered: ${replied}` : `Asked: ${asked}`,
    MAX_EXCERPT_CODE_POINTS,
  );
}

/* `content` is a string or an array of parts; anything else is no text, not `[object Object]`. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join(" ")
    .trim();
}

/* Only a matched pair wrapping the whole answer: a title containing a quote keeps it. */
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u00ab", "\u00bb"],
  ];
  for (const [open, close] of pairs) {
    if (
      trimmed.length > 1 &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/* Finished rows kept an hour, given-up rows a day. That day IS the backoff before a fresh offer. */
export async function forgetSettledSummaries(
  options: Pick<ChannelSummaryOptions, "queue" | "maxAttempts">,
): Promise<number> {
  return await options.queue.purge({
    kind: CHANNEL_SUMMARY_KIND,
    olderThanMs: 24 * 60 * 60 * 1_000,
    finishedOlderThanMs: 60 * 60 * 1_000,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });
}
