import type { KiteState } from "@/components/agents/kite/bot-kite";
import { waitingOnYou } from "@/components/bot-profile/attention";
import type { AgentProfile } from "@/lib/agents/queries";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";
import type { ChannelSummary } from "@/lib/channels/queries";

/*
 * What Kite Bot's sidebar and its Sky say about each Bot, worked out from three things OpenBot
 * already loads: the Bots, the conversations, and what waits on the person. Plain functions, so the
 * frame and the tests read one answer.
 */

/** One Bot as Kite Bot draws it. */
export type KiteBot = {
  bot: AgentProfile;
  /** What its kite shows: waiting on the person, working in a conversation, or neither. */
  state: KiteState;
  /** How many things it waits on the person for, counted as every badge in OpenBot counts them. */
  waiting: number;
  /** Where the newest thing it waits on sits, when that is a conversation. */
  waitingIn: string | null;
  paused: boolean;
  /** Whether it said something in one of its conversations that the person has not seen. */
  unread: boolean;
  /** Its conversations with the person alone, pinned first, then newest first. */
  conversations: ChannelSummary[];
  /** When it last spoke or was spoken to in any conversation, or null for never. */
  lastActiveAt: string | null;
};

/** A conversation with one Bot, which Kite Bot files under that Bot. */
export function isOneToOne(channel: ChannelSummary): boolean {
  return channel.agentIds.length === 1;
}

/** When a conversation last moved: its last message, or when it was made. */
export function activityOf(channel: ChannelSummary): string {
  return channel.lastMessageAt ?? channel.createdAt;
}

const newestFirst = (a: ChannelSummary, b: ChannelSummary) =>
  activityOf(b).localeCompare(activityOf(a));

/**
 * Whether a Bot has said something this member has not had on screen yet: the same rule as
 * OpenBot's own roster (`hasUnseenActivity`), kept beside the rows that use it here.
 */
export function unseen(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null)
    return false;
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/**
 * Every Bot the sidebar lists, with what its kite shows. In a steady order (pinned Bots first, then
 * by name), so a row never moves under the pointer because a Bot spoke: what needs the person is
 * lifted into its own section above instead.
 */
export function kiteBots(
  bots: readonly AgentProfile[],
  channels: readonly ChannelSummary[],
  attention: readonly BotAttention[],
  openChannelId?: string,
): KiteBot[] {
  return bots
    .filter((bot) => !bot.hidden)
    .map((bot) => {
      const held = attention.find((one) => one.botId === bot.id);
      const involved = channels.filter((channel) =>
        channel.agentIds.includes(bot.id),
      );
      const conversations = involved
        .filter(isOneToOne)
        .sort(newestFirst)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned));
      const waiting = held ? waitingOnYou(held) : 0;
      const working = involved.some((channel) => channel.busy === true);
      const lastActiveAt = involved.map(activityOf).sort().reverse()[0] ?? null;
      return {
        bot,
        state: waiting > 0 ? "waiting" : working ? "working" : "idle",
        waiting,
        waitingIn: held?.waitingIn ?? null,
        paused: held?.paused ?? false,
        unread: conversations.some(
          (channel) => channel.id !== openChannelId && unseen(channel),
        ),
        conversations,
        lastActiveAt,
      } satisfies KiteBot;
    })
    .sort(
      (a, b) =>
        Number(b.bot.pinned) - Number(a.bot.pinned) ||
        a.bot.name.localeCompare(b.bot.name),
    );
}

/** The Bots that wait on the person, most waiting first. */
export function needingYou(bots: readonly KiteBot[]): KiteBot[] {
  return bots
    .filter((one) => one.waiting > 0)
    .sort((a, b) => b.waiting - a.waiting);
}

/** Conversations with more than one Bot, newest first. */
export function groupConversations(
  channels: readonly ChannelSummary[],
): ChannelSummary[] {
  return channels
    .filter((channel) => channel.agentIds.length > 1)
    .sort(newestFirst);
}

/**
 * The Sky's order: what waits on the person, then what is working, then whoever was busiest last,
 * then everyone else by name. The opposite of the sidebar's steady order, because the Sky is read
 * once, top to bottom, to see what is going on.
 */
export function skyOrder(bots: readonly KiteBot[]): KiteBot[] {
  const rank = (one: KiteBot) =>
    one.state === "waiting" ? 0 : one.state === "working" ? 1 : 2;
  return [...bots].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.waiting - a.waiting ||
      (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") ||
      a.bot.name.localeCompare(b.bot.name),
  );
}

/**
 * The one Bot whose conversations the sidebar opens out: the Bot of the conversation on screen, or
 * the Bot whose page is open. Null on any other page.
 */
export function openBotId(
  pathname: string,
  channels: readonly ChannelSummary[],
): string | null {
  const channel = /^\/channel\/([^/]+)/.exec(pathname)?.[1];
  if (channel) {
    const open = channels.find((one) => one.id === channel);
    return open && isOneToOne(open) ? (open.agentIds[0] ?? null) : null;
  }
  return /^\/bots\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/** What one line under a Bot's name says about it, on the Sky. */
export function skyLine(one: KiteBot, ago: (iso: string) => string): string {
  if (one.paused) return "Paused";
  if (one.waiting > 0)
    return one.waiting === 1
      ? "Waiting on you"
      : `Waiting on you · ${one.waiting}`;
  if (one.state === "working") return "Working";
  if (one.lastActiveAt) return `Active ${ago(one.lastActiveAt)}`;
  return one.bot.title || "Ready";
}
