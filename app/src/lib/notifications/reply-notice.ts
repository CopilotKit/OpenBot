import type { QueryClient } from "@tanstack/react-query";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import {
  type BotAttention,
  type BotNotify,
  botAttentionBodyQueryOptions,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import type { ChannelActivityEvent } from "@/lib/channels/use-channel-events";
import { notificationsAllowed } from "./permission";
import { conversationTag, inSight, type Notice, showNotice } from "./show";

/**
 * A notification when a Bot replies while OpenBot is out of sight: what the offer to turn them on
 * promises with "when your Bot finishes". It comes off the roster's socket, which hears every reply
 * in every conversation the person is in, whoever started the run: this tab, another one, a routine
 * or a hand-off.
 */

/** A Bot's message, as the socket announces it: never a person's, a name, a pin or a busy dot. */
export function isBotReply(activity: ChannelActivityEvent): boolean {
  return (
    activity.lastMessageAgentId !== null &&
    activity.lastMessage !== null &&
    activity.summary === undefined &&
    activity.opening === undefined &&
    activity.pinned === undefined &&
    activity.busy === undefined &&
    activity.work === undefined &&
    activity.deleted === undefined
  );
}

/** The tag is one per reply, so two open tabs show one notice; the path is the conversation. */
export type ReplyNotice = Omit<Notice, "onClick">;

/**
 * What one reply's notice says, or null when there is none to show: not a Bot's reply, or a Bot the
 * person told to reach them only when it needs them, or never. `notify` is the Bot's own setting,
 * read from the Bot (`/lifecycle`): the attention list names only Bots with something waiting, so a
 * Bot missing from it says nothing about its setting. Unknown, there is no notice.
 */
export function replyNotice(
  activity: ChannelActivityEvent,
  notify: BotNotify | null,
  bots: readonly BotAttention[] | undefined,
  agents: readonly Pick<AgentProfile, "id" | "name">[] | undefined,
): ReplyNotice | null {
  if (!isBotReply(activity)) return null;
  if (notify !== "all") return null;
  const agentId = activity.lastMessageAgentId;
  const bot = bots?.find((each) => each.agentId === agentId);
  const name = bot?.name ?? agents?.find((each) => each.id === agentId)?.name;
  // A server older than `firstLine` sends only the preview, every line run into one.
  const body =
    typeof activity.firstLine === "string"
      ? activity.firstLine
      : (activity.lastMessage ?? "");
  return {
    title: name ? `${name} replied` : "Your Bot replied",
    body,
    tag: conversationTag(activity.channelId),
    path: `/channel/${encodeURIComponent(activity.channelId)}`,
  };
}

/**
 * ONE MOMENT, ONE NOTICE. A turn reports its reply more than once (each run of a turn reports what
 * it said, and a placeholder is reported again once filled in), and a turn that ends asking the
 * person something also raises "needs you" from the attention counts, as does the server's own
 * "A question needs your answer" line. So a reply is not announced when it arrives:
 *
 * - it waits for the conversation's turn to end (its `busy` signal goes off), and then a moment
 *   more, keeping only the newest reply of the turn;
 * - it is dropped when the conversation is then waiting on the person (`waitingIn`, read fresh):
 *   the "needs you" notice is that moment's one notice;
 * - a reply already announced, by its words, is not announced again;
 * - its tag is the conversation's, shared with the "needs you" notice, so a browser or Windows
 *   replaces one with the other rather than stacking them.
 */
export const replyTiming = {
  /** After the turn ends, how long more replies of it may still arrive. */
  settleMs: 1500,
  /** The longest a reply waits on a turn whose end never arrives. */
  turnMs: 120_000,
};

type Pending = {
  activity: ChannelActivityEvent;
  timer: ReturnType<typeof setTimeout> | null;
  since: number;
};

/** Per conversation, the newest reply of a turn not yet announced. */
const pending = new Map<string, Pending>();
/** Conversations whose turn is under way, as the socket's busy signals say. */
const busy = new Set<string>();
/** Replies already announced, by conversation and words. */
const announced = new Set<string>();
const ANNOUNCED_KEPT = 200;

const wordsKey = (activity: ChannelActivityEvent) =>
  `${activity.channelId}\u0000${activity.lastMessageAgentId}\u0000${
    activity.firstLine ?? activity.lastMessage ?? ""
  }`;

function remember(key: string) {
  announced.add(key);
  if (announced.size > ANNOUNCED_KEPT) {
    const oldest = announced.values().next().value;
    if (oldest !== undefined) announced.delete(oldest);
  }
}

/** For tests: forget every turn and reply, as a fresh page does. */
export function forgetReplies() {
  for (const each of pending.values()) if (each.timer) clearTimeout(each.timer);
  pending.clear();
  busy.clear();
  announced.clear();
}

/**
 * Every event of the roster's socket passes here: a Bot's reply is held for its turn's end, and a
 * busy signal ends or starts a turn. `open` takes a browser to the conversation when the notice is
 * clicked; OpenBot Desktop opens the notice's own `path` instead.
 */
export function noticeChannelEvent(
  activity: ChannelActivityEvent,
  queryClient: QueryClient,
  open: (channelId: string) => void,
): void {
  const { channelId } = activity;
  if (activity.busy !== undefined) {
    if (activity.busy) busy.add(channelId);
    else busy.delete(channelId);
    const held = pending.get(channelId);
    if (held) arm(held, queryClient, open);
    return;
  }
  if (!isBotReply(activity)) return;
  if (announced.has(wordsKey(activity))) return;
  const held = pending.get(channelId);
  if (held?.timer) clearTimeout(held.timer);
  const next: Pending = {
    activity,
    timer: null,
    since: held?.since ?? Date.now(),
  };
  pending.set(channelId, next);
  arm(next, queryClient, open);
}

/** Wait for the turn to end and settle; a turn still running waits on, up to its limit. */
function arm(
  held: Pending,
  queryClient: QueryClient,
  open: (channelId: string) => void,
) {
  if (held.timer) clearTimeout(held.timer);
  const { channelId } = held.activity;
  const overdue = Date.now() - held.since >= replyTiming.turnMs;
  if (busy.has(channelId) && !overdue) {
    held.timer = setTimeout(
      () => arm(held, queryClient, open),
      replyTiming.turnMs,
    );
    return;
  }
  held.timer = setTimeout(() => {
    if (pending.get(channelId) !== held) return;
    if (busy.has(channelId) && Date.now() - held.since < replyTiming.turnMs) {
      arm(held, queryClient, open);
      return;
    }
    pending.delete(channelId);
    void announce(held.activity, queryClient, open);
  }, replyTiming.settleMs);
}

async function announce(
  activity: ChannelActivityEvent,
  queryClient: QueryClient,
  open: (channelId: string) => void,
): Promise<void> {
  const key = wordsKey(activity);
  if (announced.has(key) || inSight()) return;
  // Waits for OpenBot Desktop's answer when it is still on its way; looked at again after.
  if (!(await notificationsAllowed())) return;
  if (announced.has(key) || inSight()) return;
  remember(key);

  // Read fresh: whether this conversation now waits on the person decides which notice it is.
  let bots: BotAttention[] | undefined;
  try {
    bots = (
      await queryClient.fetchQuery({
        ...botAttentionBodyQueryOptions(),
        staleTime: 0,
      })
    ).bots;
  } catch {
    bots = queryClient.getQueryData(
      botAttentionBodyQueryOptions().queryKey,
    )?.bots;
  }
  if (bots?.some((bot) => bot.waitingIn === activity.channelId)) return;
  // The Bot's own setting, read fresh: it may have been changed in another tab.
  let notify: BotNotify | null = null;
  if (activity.lastMessageAgentId)
    try {
      notify = (
        await queryClient.fetchQuery({
          ...botLifecycleQueryOptions(activity.lastMessageAgentId),
          staleTime: 0,
        })
      ).notify;
    } catch {
      // Unknown: no notice, never a guess that it wants every reply.
    }
  const notice = replyNotice(
    activity,
    notify,
    bots,
    queryClient.getQueryData(agentListQueryOptions().queryKey),
  );
  // Looked at again: the person may have come back while the list loaded.
  if (!notice || inSight()) return;
  showNotice({ ...notice, onClick: () => open(activity.channelId) });
}
