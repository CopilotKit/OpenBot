import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import { type ModelPick, requestFor, shownPick } from "./effort";
import { setConversationModelMutationOptions } from "./mutations";
import {
  type ConversationModel,
  conversationModelQueryOptions,
  type ModelCatalogue,
  type ModelExposure,
  modelCatalogueQueryOptions,
} from "./queries";

const SAVE_FAILED_TOAST = "conversation-model-save";

/**
 * What the composer says when the model a person picked for a conversation stopped being offered
 * while they were in it. In a team an admin decides what is offered, so it is no longer allowed; on
 * one person's own machine the provider stopped listing it.
 */
export function withdrawnModelNotice(
  picked: string,
  now: string,
  exposure: ModelExposure,
): string {
  const gone = exposure === "allowed" ? "isn't allowed" : "isn't available";
  return `${picked} ${gone} any more, so this conversation now uses ${now}. Pick another model to change it.`;
}

/**
 * The model and thinking effort one conversation runs on, as its picker shows them, and the way
 * to change them.
 *
 * The pick is the server's: saved per person and conversation, and read there when each run starts.
 * The browser never names a model or an effort on a run, so what this shows is what the next
 * message uses. While a save is in flight the picker shows the new pick and is held still, so a
 * second change cannot race the first.
 *
 * A PICK THAT STOPS BEING OFFERED IS SAID, NEVER SWAPPED SILENTLY. An admin can take the picked
 * model off the allowlist while the conversation is open. The server then runs the next message on
 * the default and keeps the pick for when the model is offered again. So each send first asks the
 * server again what the conversation runs on, which also brings the picker in line, and when the
 * person's own pick has turned into the default without them choosing it, and the model is no
 * longer offered, `notice` says so in the composer. It goes when the person picks a model, or when
 * the model is offered again.
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

  const [withdrawn, setWithdrawn] = useState<{
    channelId: string;
    model: string;
    notice: string;
  } | null>(null);
  /** The model the person last knew this conversation to run on: null for the default. */
  const known = useRef<{ channelId: string; model: string | null } | null>(
    null,
  );
  /** Every model's label seen here, so one dropped from the list is still named by its label. */
  const labels = useRef(new Map<string, string>());
  for (const option of catalogue?.models ?? [])
    labels.current.set(option.id, option.label);
  /** The check of a pick that turned into the default, while one is under way. */
  const checking = useRef<Promise<void> | null>(null);

  /**
   * Hear what the server says the conversation runs on now. A pick that became the default is only
   * withdrawn when the model is no longer offered: the same person may have picked the default in
   * another tab, which says nothing.
   */
  const hear = (data: ConversationModel): Promise<void> => {
    const before =
      known.current?.channelId === channelId ? known.current.model : undefined;
    known.current = { channelId, model: data.model };
    if (data.model !== null) {
      setWithdrawn(null);
      // Offered again since the list here was read: read it again, so the picker shows it.
      if (catalogue && !catalogue.models.some((m) => m.id === data.model))
        return queryClient
          .invalidateQueries({
            queryKey: modelCatalogueQueryOptions().queryKey,
          })
          .catch(() => undefined);
      return Promise.resolve();
    }
    if (!before) return Promise.resolve();
    const check = queryClient
      .fetchQuery({ ...modelCatalogueQueryOptions(), staleTime: 0 })
      .then((fresh) => {
        if (fresh.models.some((option) => option.id === before)) return;
        const now =
          fresh.models.find((option) => option.id === fresh.default)?.label ??
          fresh.default;
        setWithdrawn({
          channelId,
          model: before,
          notice: withdrawnModelNotice(
            labels.current.get(before) ?? before,
            now,
            fresh.exposure,
          ),
        });
      })
      // The server decides what a run uses either way; a check that failed only goes unsaid.
      .catch(() => undefined);
    checking.current = check;
    return check;
  };
  const hearRef = useRef(hear);
  hearRef.current = hear;

  // A read of the pick from anywhere (a send, the window coming back into focus) is heard.
  useEffect(() => {
    if (!choosable || saved.data === undefined || save.isPending) return;
    void hearRef.current(saved.data);
  }, [choosable, saved.data, save.isPending]);

  return {
    /** What the picker shows. Undefined until both the catalogue and the pick have loaded. */
    value:
      choosable && saved.data === undefined
        ? undefined
        : shownPick(picked, catalogue),
    saving: save.isPending,
    /** What the composer says about the pick, when the picked model stopped being offered. */
    notice: withdrawn?.channelId === channelId ? withdrawn.notice : null,
    // Read the ref at submission time, including a choice made before React renders again.
    beforeSend: async () => {
      await pendingSave.current;
      if (!choosable) return;
      try {
        const now = await queryClient.fetchQuery({
          ...conversationModelQueryOptions(channelId),
          staleTime: 0,
        });
        await hear(now);
      } catch {
        // The server reads the pick when the run starts; a failed look here holds nothing back.
      }
      await checking.current;
    },
    choose: (pick: ModelPick) => {
      const requested = requestFor(pick, catalogue);
      // The person's own choice: whatever it turns into on the server is theirs, not withdrawn.
      known.current = { channelId, model: requested.model };
      setWithdrawn(null);
      const pending = save.mutateAsync(
        { channelId, pick: requested },
        {
          onError: (error) => {
            // The save failed, so what the server holds is not what was asked for: start again.
            known.current = null;
            toast.add({
              id: SAVE_FAILED_TOAST,
              title: error.message,
              type: "error",
            });
          },
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
