import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ConversationModel, modelKeys } from "./queries";

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
  pick: ConversationModel,
): Promise<ConversationModel> {
  return (
    await client(`/api/channels/${encodeURIComponent(channelId)}/model`, {
      method: "PUT",
      body: { model: pick.model, effort: pick.effort },
      fallback: FALLBACK,
    })
  ).json();
}

export function setConversationModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { channelId: string; pick: ConversationModel }) =>
      saveConversationModel(variables.channelId, variables.pick),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({
        queryKey: modelKeys.conversation(variables.channelId),
      }),
  });
}
