import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import { setConversationModelMutationOptions } from "./mutations";
import { conversationModelQueryOptions, type ModelCatalogue } from "./queries";

const SAVE_FAILED_TOAST = "conversation-model-save";

/** The model id a picker shows: the pick when the catalogue offers it, otherwise the default. */
function shown(
  picked: string | null | undefined,
  catalogue: ModelCatalogue | undefined,
): string | undefined {
  if (picked && catalogue?.models.some((model) => model.id === picked))
    return picked;
  return catalogue?.default;
}

/**
 * The model one conversation runs on, as its picker shows it, and the way to change it.
 *
 * The pick is the server's: saved per person and conversation, and read there when each run starts.
 * The browser never names a model on a run, so what this shows is what the next message uses.
 * While a save is in flight the picker shows the new pick and is held still, so a second change
 * cannot race the first.
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
  const pendingSave = useRef<Promise<string | null> | null>(null);
  const picked = save.isPending ? save.variables.model : saved.data;

  return {
    /** What the picker shows. Undefined until both the catalogue and the pick have loaded. */
    value:
      choosable && saved.data === undefined
        ? undefined
        : shown(picked, catalogue),
    saving: save.isPending,
    // Read the ref at submission time, including a choice made before React renders again.
    beforeSend: async () => {
      await pendingSave.current;
    },
    choose: (model: string) => {
      const pending = save.mutateAsync(
        { channelId, model: model === catalogue?.default ? null : model },
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
  const [picked, setPicked] = useState<string | null>(null);
  const value = shown(picked, catalogue);
  return {
    value,
    /** What to save with the new conversation: nothing, when it is the default. */
    requested: value && value !== catalogue?.default ? value : null,
    choose: (model: string) =>
      setPicked(model === catalogue?.default ? null : model),
  };
}
