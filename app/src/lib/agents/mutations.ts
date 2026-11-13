import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { createBot, deleteBot, updateBot } from "@/lib/api/generated/bots/bots";
import type { CreateBotRequest } from "@/lib/api/generated/model";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { noteBotCreated } from "@/lib/star-prompt";
import { type AgentProfile, agentApiPath, agentKeys } from "./queries";

/**
 * What a Bot is created or changed with: api/openapi.yaml's `CreateBotRequest`, generated from the
 * spec. A change sends the same fields; `harness` is read on create only.
 */
export type AgentInput = CreateBotRequest;

/**
 * A fresh key for each write a person asks for. TanStack does not retry a mutation, so each attempt
 * is a new write; a retry of the same write would reuse its key.
 */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Couldn't save that change to the Bot.";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: AgentInput): Promise<AgentProfile> =>
      (
        await createBot(ORGANIZATION_ID, input, once(), {
          fallback: FALLBACK,
        })
      ).bot,
    onSuccess: () => {
      // Here rather than in the New Bot sheet, so a Bot made from a conversation counts too.
      noteBotCreated();
      return invalidateAgents(queryClient);
    },
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      (
        await updateBot(
          ORGANIZATION_ID,
          variables.agentId,
          variables.input,
          once(),
          { fallback: FALLBACK },
        )
      ).bot,
    // A conversation is called by its Bot's name, so a rename shows in the sidebar and the header.
    onSuccess: () =>
      Promise.all([
        invalidateAgents(queryClient),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
      ]),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`${agentApiPath(agentId)}/duplicate`, "agent", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; pinned: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.pinned ? "pin" : "unpin"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await deleteBot(ORGANIZATION_ID, agentId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Issue this coworker a credential for calling tools back, and hand it over once.
 *
 * The token is in this response and nowhere else, ever again, so the caller has to show it to the
 * person immediately. Calling this on a coworker that already has one rotates it, which is how a
 * leaked token is retired.
 */
export function issueCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<string> =>
      client(`${agentApiPath(agentId)}/callback-token`, "token", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Take the credential away. The coworker may still talk; it may not reach anything outside a chat. */
export function revokeCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(`${agentApiPath(agentId)}/callback-token`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same `plugin_grants` write every other grant makes, with `kind: "bot"`, so the audit row and
 * the refusals are the ones already in place: an administrator only, never a Bot on itself, and
 * never onto a Bot that does not exist.
 *
 * DIRECTIONAL, and the two ids are easy to swap: `agentId` is the Bot doing the asking and `ref` is
 * the Bot it may reach. Granted the other way round it reads as working and hands over nothing.
 */
export function setHandoffGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      /** The Bot doing the asking. */
      agentId: string;
      /** The Bot it may reach. */
      ref: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "bot", ref: variables.ref, agentId: variables.agentId },
          fallback: FALLBACK,
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=bot&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
