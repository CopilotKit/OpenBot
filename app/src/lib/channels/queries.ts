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
  /**
   * ISO-8601 when something was last said here, or null for a conversation nobody has used.
   *
   * The conversation screen needs this to tell two silences apart: a new conversation with no
   * history, and one whose history this deployment cannot reach. See `channel-chat.tsx`.
   */
  lastMessageAt: string | null;
  /**
   * What this conversation is waiting on right now, oldest first. See `ChannelWork`.
   *
   * Read with the channel and replaced whole by every busy event, so a reload shows the same thing
   * the socket last said. Absent from a server that predates it, which reads as nothing.
   */
  work?: ChannelWork[];
  /**
   * When the server read `work`, from the socket event that last set it. Absent on a fetched read.
   * Kept so an older event arriving late does not put back a list that has moved on.
   */
  workAt?: string;
};

/**
 * Something a conversation is waiting on that nobody's browser is running: a Bot its Bot asked,
 * answering out of sight, or a routine firing into it.
 *
 * The server reads it from the hop queue and the routine runs, so it holds for as long as the work
 * does, across reloads and replicas. `since` is when it started, for the timer a person watches.
 */
export type ChannelWork =
  | {
      kind: "handoff";
      key: string;
      /** The Bot that was asked. */
      botId: string;
      /** Its name when it was asked, or null. Prefer the roster's name when the person has one. */
      botName: string | null;
      /** ISO-8601. */
      since: string;
    }
  | {
      kind: "routine";
      key: string;
      routineId: string;
      /** The Bot the routine runs as. */
      botId: string;
      botName: string | null;
      /** ISO-8601. */
      since: string;
    };

/** A channel plus what the roster renders about it. */
export type ChannelSummary = AgentChannel & {
  /** A few words about the conversation, or null. The roster falls back to `name`. */
  summary: string | null;
  lastMessage: string | null;
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
   * Mostly socket-only and transient: a person's own run is announced and never stored, so a
   * refetch drops it. The roster returns it true for a channel with `work`, which is stored, so a
   * conversation a Bot is still answering in stays lit across a reload. A headless turn — a handoff
   * hop, a relay — sets it, which is how the roster shows work the browser never streamed.
   */
  busy?: boolean;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  /** Every channel read by id, to refetch them together. */
  details: () => ["channels", "detail"] as const,
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
        fallback: "Couldn't load your conversations.",
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
        fallback: "Couldn't load this conversation.",
      });
    },
  });
}
