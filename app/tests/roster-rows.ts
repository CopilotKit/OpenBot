import type { ChannelSummary } from "../src/lib/channels/queries";
import type { ChannelActivityEvent } from "../src/lib/channels/use-channel-events";

/**
 * A conversation as the server lists it while a person's own turn runs in it: no `busy`, since the
 * server holds no row that says a browser's turn is running.
 */
export function listedRow(id: string): ChannelSummary {
  return {
    id,
    name: "Personal Assistant",
    agentIds: ["bot-1"],
    threadId: `thread-${id}`,
    active: true,
    summary: "Tagged meeting follow-ups",
    lastMessage: "Slack is ready now. Please carry on.",
    lastMessageAt: "2026-11-25T18:52:00.000Z",
    lastMessageAgentId: null,
    createdAt: "2026-11-25T18:40:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-25T18:52:00.000Z",
    work: [],
  };
}

/** A turn starting or ending in a conversation, as the socket says it. */
export function busyEvent(
  channelId: string,
  busy: boolean,
): ChannelActivityEvent {
  return {
    channelId,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    busy,
    work: [],
    workAt: new Date().toISOString(),
  };
}
