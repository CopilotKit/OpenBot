import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import { type ModelPick, requestFor, shownPick } from "./effort";
import { setConversationModelMutationOptions } from "./mutations";
import {
  type ConversationModel,
  conversationModelQueryOptions,
  type ModelCatalogue,
} from "./queries";

const SAVE_FAILED_TOAST = "conversation-model-save";

/**
 * The model and thinking effort one conversation runs on, as its picker shows them, and the way
 * to change them.
 *
 * The pick is the server's: saved per person and conversation, and read there when each run starts.
 * The browser never names a model or an effort on a run, so what this shows is what the next
 * message uses. While a save is in flight the picker shows the new pick and is held still, so a
 * second change cannot race the first.
 */
export function useConversationModel(
  channelId: string,
  catalogue: ModelCatalogue | undefined,
) {
  const choosable = catalogue?.choosable === true;
  const saved = useQuery({
    ...conversationModelQueryOptions(channelId),
    enabled: choosable,
  });
  const save = useMutation(setConversationModelMutationOptions(queryClient));
  const pendingSave = useRef<Promise<ConversationModel> | null>(null);
  const picked = save.isPending ? save.variables.pick : saved.data;

  return {
    /** What the picker shows. Undefined until both the catalogue and the pick have loaded. */
    value:
      choosable && saved.data === undefined
        ? undefined
        : shownPick(picked, catalogue),
    saving: save.isPending,
    // Read the ref at submission time, including a choice made before React renders again.
    beforeSend: async () => {
      await pendingSave.current;
    },
    choose: (pick: ModelPick) => {
      const pending = save.mutateAsync(
        { channelId, pick: requestFor(pick, catalogue) },
        {
          onError: (error) =>
            toast.add({
              id: SAVE_FAILED_TOAST,
              title: error.message,
              type: "error",
            }),
        },
      );
      pendingSave.current = pending;
      // The mutation reports save errors through the toast above. A send waiting on the original
      // promise still rejects, so its composer keeps the draft instead of running the old model.
      void pending.then(
        () => {
          if (pendingSave.current === pending) pendingSave.current = null;
        },
        () => {
          if (pendingSave.current === pending) pendingSave.current = null;
        },
      );
    },
  };
}

/**
 * The pick for a conversation that does not exist yet. Held here until the first message creates
 * the conversation, which saves it before that message runs (`lib/channels/start.ts`).
 */
export function useDraftModel(catalogue: ModelCatalogue | undefined) {
  const [picked, setPicked] = useState<ConversationModel>({
    model: null,
    effort: null,
  });
  const value = shownPick(picked, catalogue);
  const requested = value ? requestFor(value, catalogue) : null;
  return {
    value,
    /** What to save with the new conversation: nothing, when both are the defaults. */
    requested:
      requested && (requested.model !== null || requested.effort !== null)
        ? requested
        : null,
    choose: (pick: ModelPick) => setPicked(requestFor(pick, catalogue)),
  };
}
