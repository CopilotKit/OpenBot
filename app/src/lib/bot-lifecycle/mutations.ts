import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import {
  type BotLifecycle,
  type BotNotify,
  botLifecycleKeys,
  botPath,
  type ResetPlan,
  type UpdateKind,
  type UpdateTransport,
} from "./queries";

const FALLBACK = "Bot operation failed";

/** Everything here moves badges, Activity and state together, so all of it is refetched. */
function invalidateLifecycle(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: botLifecycleKeys.all });
}

export function setBotPausedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      paused: boolean;
    }): Promise<BotLifecycle> =>
      client(
        `${botPath(variables.agentId)}/${variables.paused ? "pause" : "resume"}`,
        "lifecycle",
        { method: "POST", fallback: FALLBACK },
      ),
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function setBotNotifyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      notify: BotNotify;
    }): Promise<BotLifecycle> =>
      client(`${botPath(variables.agentId)}/notifications`, "lifecycle", {
        method: "PUT",
        body: { notify: variables.notify },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function resetBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<ResetPlan> =>
      client(`${botPath(agentId)}/reset`, "deleted", {
        method: "POST",
        body: { confirm: true },
        fallback: "Could not reset this Bot",
      }),
    onSuccess: async () => {
      await invalidateLifecycle(queryClient);
      // Conversations were deleted; the roster has to drop them.
      await queryClient.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

export function stopHandoffMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; id: string }) => {
      await client(`${botPath(variables.agentId)}/activity/handoffs/stop`, {
        method: "POST",
        body: { id: variables.id },
        fallback: "Could not stop the delegated task",
      });
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function cancelFollowUpMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; id: string }) => {
      await client(`${botPath(variables.agentId)}/follow-ups/cancel`, {
        method: "POST",
        body: { id: variables.id },
        fallback: "Could not cancel the follow-up",
      });
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function setUpdateRoutingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      kind: UpdateKind;
      transports: UpdateTransport[] | "all";
    }) => {
      await client(`/api/bots/routing/${variables.kind}`, {
        method: "PUT",
        body: { transports: variables.transports },
        fallback: "Could not save where updates go",
      });
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}
