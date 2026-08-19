import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { type AgentChannel, channelKeys } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await fetch("/api/channels", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds }),
      });
      if (!response.ok) {
        const message = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => undefined);
        throw new Error(message ?? "Could not start a channel");
      }
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
      await fetch(`/api/channels/${variables.channelId}/activity`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: variables.agentId,
          at: variables.at,
          text: variables.text,
        }),
      });
    },
  });
}
