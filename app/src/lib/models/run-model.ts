import { useCopilotKit } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogue } from "./queries";

/**
 * The forwarded property a run names its model in. The server reads the same name
 * (`RUN_MODEL_PROPERTY` in server/src/model-catalogue.ts) and checks it against what it offers.
 */
export const RUN_MODEL_PROPERTY = "openbotModel";

const KEY = "openbot.model";

/** Where one conversation's pick is kept. Per conversation, so each one remembers its own. */
export function modelChoiceKey(conversationId: string): string {
  return `${KEY}:${conversationId}`;
}

function remembered(conversationId: string): string | null {
  try {
    return window.localStorage.getItem(modelChoiceKey(conversationId));
  } catch {
    // Storage can be unavailable. The conversation still works on OpenBot's own model.
    return null;
  }
}

function remember(conversationId: string, model: string | null): void {
  try {
    if (model)
      window.localStorage.setItem(modelChoiceKey(conversationId), model);
    else window.localStorage.removeItem(modelChoiceKey(conversationId));
  } catch {
    // As above: the pick holds for this visit and is simply not there next time.
  }
}

/**
 * The model one conversation runs on, as the picker shows it.
 *
 * A remembered pick the catalogue no longer offers (the admin narrowed the allowlist, the provider
 * retired the model) reads as the default, so the picker never shows a model a send would refuse.
 * Picking the default forgets the pick, so a conversation follows OpenBot's own model when that
 * changes.
 */
export function useConversationModel(
  conversationId: string | undefined,
  catalogue: ModelCatalogue | undefined,
) {
  const [picked, setPicked] = useState<string | null>(() =>
    conversationId ? remembered(conversationId) : null,
  );
  useEffect(() => {
    setPicked(conversationId ? remembered(conversationId) : null);
  }, [conversationId]);

  const offered =
    picked && catalogue?.models.some((model) => model.id === picked)
      ? picked
      : undefined;
  const value = offered ?? catalogue?.default;

  const choose = useCallback(
    (model: string) => {
      const next = model === catalogue?.default ? null : model;
      setPicked(next);
      if (conversationId) remember(conversationId, next);
    },
    [catalogue?.default, conversationId],
  );

  return {
    /** What the picker shows. Undefined until the catalogue has loaded. */
    value,
    /** What runs should ask for: nothing, when it is the default. */
    requested: value && value !== catalogue?.default ? value : undefined,
    choose,
  };
}

/**
 * Send the picked model with every run of this agent: a typed message, a queued one, a resumed
 * handoff. Scoped to the agent, which is per conversation, so another conversation is untouched.
 * Nothing is sent while the default is picked, so those runs are exactly what they were before.
 */
export function useRunModel(agentId: string, model: string | undefined): void {
  const { copilotkit } = useCopilotKit();
  useEffect(() => {
    if (!model) return;
    const id = copilotkit.addScopedProperties({
      properties: { [RUN_MODEL_PROPERTY]: model },
      agentIds: [agentId],
    });
    return () => copilotkit.removeScopedProperties(id);
  }, [copilotkit, agentId, model]);
}
