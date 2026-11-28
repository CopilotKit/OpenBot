import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { replaceModelChoice } from "@/lib/api/generated/models/models";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import {
  type ConversationModel,
  type ConversationModelInput,
  modelKeys,
} from "./queries";

const FALLBACK = "Couldn't save the model. Try again.";

/**
 * Save the model and thinking effort one conversation runs on, or forget either with null. The
 * server refuses a model it does not offer, an effort the model does not accept, and any pick while
 * an admin has picking off.
 *
 * A plain function as well as the factory below, because starting a conversation saves its pick as
 * one step inside a larger write (`lib/channels/start.ts`), where no hook can run.
 */
export async function saveConversationModel(
  channelId: string,
  pick: ConversationModelInput,
): Promise<ConversationModel> {
  return replaceModelChoice(
    organizationId(),
    "me",
    channelId,
    pick,
    { "Idempotency-Key": idempotencyKey() },
    { fallback: FALLBACK },
  );
}

export function setConversationModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      channelId: string;
      pick: ConversationModelInput;
    }) => saveConversationModel(variables.channelId, variables.pick),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({
        queryKey: modelKeys.conversation(variables.channelId),
      }),
  });
}
