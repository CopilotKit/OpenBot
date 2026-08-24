import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { type AgentChannel, channelKeys } from "./queries";

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
 * Delete a channel, and ask the platform to forget the thread behind it.
 *
 * Other tabs learn a channel is gone from the socket event in `use-channel-events.ts`; this tab
 * issued the delete itself and never receives its own event, so it clears the roster and detail
 * cache directly on success.
 *
 * Resolves to whether the message history outlived the channel. The local delete commits first and
 * the thread deletion can fail on its own, so this is not a failure to throw on: the conversation
 * is gone either way, and the caller shows the residue rather than reporting an error that did not
 * happen.
 */
export function deleteChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string): Promise<boolean> => {
      const response = await client(`/api/channels/${channelId}`, {
        method: "DELETE",
        fallback: "Could not delete this conversation",
      });
      const body = (await response.json()) as { historyLeftBehind?: boolean };
      return body.historyLeftBehind === true;
    },
    onSuccess: (_data, channelId) => {
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
      queryClient.removeQueries({ queryKey: channelKeys.detail(channelId) });
    },
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
