import { queryOptions } from "@tanstack/react-query";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same teammate independent conversations, and
 * `active` is false once a linked teammate has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
};

/** A channel plus the last thing said in it, which is what the roster renders. */
export type ChannelSummary = AgentChannel & {
  lastMessage: string | null;
  /** ISO-8601, or null for a channel nobody has used yet. */
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
};

export function channelListQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.list(),
    queryFn: async (): Promise<ChannelSummary[]> => {
      const response = await fetch("/api/channels", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load channels");
      return ((await response.json()) as { channels: ChannelSummary[] })
        .channels;
    },
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      const response = await fetch(`/api/channels/${channelId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load this channel");
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
  });
}
