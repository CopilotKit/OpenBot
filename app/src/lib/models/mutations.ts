import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { modelKeys } from "./queries";

const FALLBACK = "Couldn't save the model. Try again.";

/**
 * Save the model one conversation runs on, or forget the pick with null. The server refuses a model
 * it does not offer, and any pick while an admin has picking off.
 *
 * A plain function as well as the factory below, because starting a conversation saves its pick as
 * one step inside a larger write (`lib/channels/start.ts`), where no hook can run.
 */
export function saveConversationModel(
  channelId: string,
  model: string | null,
): Promise<string | null> {
  return client(
    `/api/channels/${encodeURIComponent(channelId)}/model`,
    "model",
    {
      method: "PUT",
      body: { model },
      fallback: FALLBACK,
    },
  );
}

export function setConversationModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { channelId: string; model: string | null }) =>
      saveConversationModel(variables.channelId, variables.model),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({
        queryKey: modelKeys.conversation(variables.channelId),
      }),
  });
}
