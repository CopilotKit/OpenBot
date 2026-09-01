import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
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
  /** Parallel to agentIds; null means use the generated fallback. */
  avatarUrls: (string | null)[];
  lastMessage: string | null;
  /** ISO-8601, or null for a channel nobody has used yet. */
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
  /** Whether this member pinned the channel. Pinned channels sort first in the roster. */
  pinned: boolean;
  /** ISO-8601 when this member last had the channel open, or null for never. The caller's, only. */
  lastReadAt: string | null;
  /**
   * Whether a turn is running in this channel right now.
   *
   * Socket-only and transient: the server never persists it and the roster query never returns it,
   * so it is undefined until a busy event arrives and is dropped whenever the roster is refetched.
   * A headless turn — a handoff hop, a relay — sets it, which is how the roster shows work the
   * browser never streamed.
   */
  busy?: boolean;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
};

/** One page of channels, and where the next one starts. */
export type ChannelPage = {
  channels: ChannelSummary[];
  nextCursor: string | null;
};

/**
 * The sidebar's channels, a page at a time.
 *
 * It used to ask for every channel this person has, one row per channel-agent pair, on every render.
 * Nothing removes a channel, so somebody who talks to their Bot daily accumulates thousands and the
 * query grows monotonically for as long as they use the product.
 *
 * The pages are flattened for the caller, so the sidebar and the socket that patches it both see one
 * array in recency order and neither has to know this is paged.
 */
export function channelListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: channelKeys.list(),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<ChannelPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam as string)}`
        : "";
      const response = await client(`/api/channels${suffix}`, {
        fallback: "Could not load channels",
      });
      return (await response.json()) as ChannelPage;
    },
    getNextPageParam: (page: ChannelPage) => page.nextCursor ?? undefined,
    select: (data): ChannelSummary[] =>
      data.pages.flatMap((page) => page.channels),
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      return client(`/api/channels/${channelId}`, "channel", {
        fallback: "Could not load this channel",
      });
    },
  });
}
