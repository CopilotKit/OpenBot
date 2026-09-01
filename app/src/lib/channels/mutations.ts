import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { type AgentChannel, type ChannelPage, channelKeys } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await client("/api/channels", {
        method: "POST",
        body: { agentIds },
        fallback: "Could not start a channel",
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Report the last thing said in a channel.
 *
 * The client that ran the agent already has the message before platform replay can return it; the
 * runtime exposes no run-completion hook and its run endpoint returns before the reply exists.
 *
 * Fire-and-forget on purpose: a failed preview update is a stale roster line, not a lost message.
 */
export function recordChannelActivityMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      text: string;
      agentId: string | null;
      at: string;
    }) => {
      /* Still fire-and-forget: `tryClient` does not throw, and the result is not read. */
      await tryClient(`/api/channels/${variables.channelId}/activity`, {
        method: "POST",
        body: {
          agentId: variables.agentId,
          at: variables.at,
          text: variables.text,
        },
      });
    },
  });
}

/**
 * Tell the roster this channel is (or is no longer) running a turn.
 *
 * Fire-and-forget, like recorded activity: a working indicator that fails to appear or to clear is
 * worth nothing next to the run itself, and a person is never shown an error for it. The server
 * broadcasts it to the channel's members, so the row shows a working dot even on a tab that has
 * navigated elsewhere.
 *
 * A plain function, not a mutation handle: the turn it reports on outlives the screen that started
 * it, and `mutate` on an unmounted component is a no-op.
 */
export async function setChannelBusy(variables: {
  channelId: string;
  busy: boolean;
}) {
  await tryClient(`/api/channels/${variables.channelId}/busy`, {
    method: "POST",
    body: { busy: variables.busy },
  });
}

/** Pin or unpin a channel for this member. A marker, not a reorder, so no optimistic sort. */
export function setChannelPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; pinned: boolean }) => {
      await client(`/api/channels/${variables.channelId}/pin`, {
        method: "PUT",
        body: { pinned: variables.pinned },
        fallback: "Could not pin this channel",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Stamp a channel read for this member, patching the cache before the wire answers.
 *
 * Patched in onMutate rather than refetched on success: the dot must clear the instant the channel
 * opens, not a round-trip later. No rollback on failure and no invalidation — a mark-read that did
 * not land is a dot that returns on the next refetch, which is the truth reasserting itself, and a
 * refetch here would race the socket's own patches for nothing.
 */
export function markChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}/read`, {
        method: "PUT",
        fallback: "Could not mark this channel read",
      });
    },
    onMutate: (channelId) => {
      const now = new Date().toISOString();
      queryClient.setQueryData(
        channelKeys.list(),
        (data: InfiniteData<ChannelPage> | undefined) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              channels: page.channels.map((row) =>
                row.id === channelId
                  ? {
                      ...row,
                      /*
                       * The later of now and the row's own lastMessageAt: lastMessageAt comes from
                       * another clock, and a marker stamped "now" by a clock running behind it
                       * would leave the row still reading as unseen — and the dot still lit.
                       */
                      lastReadAt:
                        row.lastMessageAt && row.lastMessageAt > now
                          ? row.lastMessageAt
                          : now,
                    }
                  : row,
              ),
            })),
          },
      );
    },
  });
}

/** Soft-delete a channel for everyone in it. The server keeps the transcript; the roster forgets. */
export function deleteChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}`, {
        method: "DELETE",
        fallback: "Could not delete this channel",
      });
    },
    // The roster only. The open channel's detail query would refetch into the fresh 404 and
    // flash an error before the navigate-home lands; left alone, it keeps its cache and the
    // navigation happens with nothing to complain about.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.list() }),
  });
}
