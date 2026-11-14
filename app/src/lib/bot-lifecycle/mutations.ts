import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  pauseBot,
  resetBot,
  resumeBot,
  stopBotHandoff,
} from "@/lib/api/generated/bots/bots";
import { cancelFollowUp } from "@/lib/api/generated/follow-ups/follow-ups";
import {
  updateBotNotificationSettings,
  updateNotificationSettings,
} from "@/lib/api/generated/notification-settings/notification-settings";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { channelKeys } from "@/lib/channels/queries";
import {
  type BotLifecycle,
  type BotNotify,
  botLifecycleKeys,
  type ResetPlan,
  type UpdateKind,
  type UpdateTransport,
} from "./queries";

const FALLBACK = "Bot operation failed";

/** A fresh key for each write a person asks for, as `once` in lib/agents/mutations.ts. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** Everything here moves badges, Activity and state together, so all of it is refetched. */
function invalidateLifecycle(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: botLifecycleKeys.all });
}

export function setBotPausedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      paused: boolean;
    }): Promise<BotLifecycle> =>
      variables.paused
        ? (
            await pauseBot(ORGANIZATION_ID, variables.agentId, once(), {
              fallback: FALLBACK,
            })
          ).lifecycle
        : resumeBot(ORGANIZATION_ID, variables.agentId, once(), {
            fallback: FALLBACK,
          }),
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

/** How much one Bot may reach the person: their own setting for that Bot, through the API. */
export function setBotNotifyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { agentId: string; notify: BotNotify }) =>
      updateBotNotificationSettings(
        ORGANIZATION_ID,
        "me",
        variables.agentId,
        { notify: variables.notify },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function resetBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string): Promise<ResetPlan> =>
      (
        await resetBot(
          ORGANIZATION_ID,
          agentId,
          { validateOnly: false },
          once(),
          {
            fallback: "Could not reset this Bot",
          },
        )
      ).deleted,
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
      await stopBotHandoff(
        ORGANIZATION_ID,
        variables.agentId,
        { handoffId: variables.id },
        once(),
        { fallback: "Could not stop the delegated task" },
      );
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}

export function cancelFollowUpMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; id: string }) => {
      await cancelFollowUp(
        ORGANIZATION_ID,
        variables.agentId,
        variables.id,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Could not cancel the follow-up" },
      );
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
      // One kind at a time, so a change on one device keeps the kinds another changed.
      await updateNotificationSettings(
        ORGANIZATION_ID,
        "me",
        { routing: { [variables.kind]: variables.transports } },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Could not save where updates go" },
      );
    },
    onSuccess: () => invalidateLifecycle(queryClient),
  });
}
