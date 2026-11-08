import type { QueryClient } from "@tanstack/react-query";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import {
  type BotAttention,
  botAttentionBodyQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import type { ChannelActivityEvent } from "@/lib/channels/use-channel-events";
import { notificationsAllowed } from "./permission";
import { type Notice, showNotice } from "./show";

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
 * person told to reach them only when it needs them, or never. A Bot the attention list does not
 * name has no setting of its own, so it gets the default, which is everything.
 */
export function replyNotice(
  activity: ChannelActivityEvent,
  bots: readonly BotAttention[] | undefined,
  agents: readonly Pick<AgentProfile, "id" | "name">[] | undefined,
): ReplyNotice | null {
  if (!isBotReply(activity)) return null;
  const agentId = activity.lastMessageAgentId;
  const bot = bots?.find((each) => each.agentId === agentId);
  if ((bot?.notify ?? "all") !== "all") return null;
  const name = bot?.name ?? agents?.find((each) => each.id === agentId)?.name;
  // A server older than `firstLine` sends only the preview, every line run into one.
  const body =
    typeof activity.firstLine === "string"
      ? activity.firstLine
      : (activity.lastMessage ?? "");
  return {
    title: name ? `${name} replied` : "Your Bot replied",
    body,
    tag: `openbot-reply-${activity.channelId}-${activity.lastMessageAt}`,
    path: `/channel/${encodeURIComponent(activity.channelId)}`,
  };
}

/** Whether the person can see OpenBot now, in which case the reply on screen says it all. */
function inSight(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Replies this page already announced. A reply can be reported twice at the same moment, once as a
 * placeholder and again when it is filled in, and that is one reply.
 */
const announced = new Set<string>();
const ANNOUNCED_KEPT = 200;

/**
 * Show a reply's notice, if OpenBot is out of sight, notifications are allowed and the Bot may say
 * this much. `open` takes a browser to the conversation when the notice is clicked; OpenBot Desktop
 * opens the notice's own `path` instead.
 */
export async function announceReply(
  activity: ChannelActivityEvent,
  queryClient: QueryClient,
  open: (channelId: string) => void,
): Promise<void> {
  if (!isBotReply(activity) || inSight() || !notificationsAllowed()) return;
  const key = `${activity.channelId}-${activity.lastMessageAt}`;
  if (announced.has(key)) return;
  announced.add(key);
  if (announced.size > ANNOUNCED_KEPT) {
    const oldest = announced.values().next().value;
    if (oldest !== undefined) announced.delete(oldest);
  }

  // The badge polls this already; read once here so a page without the badge still has it.
  let bots: BotAttention[] | undefined;
  try {
    bots = (await queryClient.ensureQueryData(botAttentionBodyQueryOptions()))
      .bots;
  } catch {
    // Without the list, the Bot's own setting is unknown, and the default is everything.
  }
  const notice = replyNotice(
    activity,
    bots,
    queryClient.getQueryData(agentListQueryOptions().queryKey),
  );
  // Looked at again: the person may have come back while the list loaded.
  if (!notice || inSight()) return;
  showNotice({ ...notice, onClick: () => open(activity.channelId) });
}
