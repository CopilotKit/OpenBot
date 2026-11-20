import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createBot,
  deleteBot,
  duplicateBot,
  hideBot,
  issueBotCallbackToken,
  pinBot,
  revokeBotCallbackToken,
  unhideBot,
  unpinBot,
  updateBot,
} from "@/lib/api/generated/bots/bots";
import type { CreateBotRequest } from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { botAgentKeys } from "@/lib/bot-agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { grantPlugin, revokePlugin } from "@/lib/plugins/mutations";
import { type AgentProfile, agentKeys } from "./queries";

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
        await createBot(organizationId(), input, once(), {
          fallback: FALLBACK,
        })
      ).bot,
    onSuccess: () => invalidateAgents(queryClient),
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
          organizationId(),
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
    mutationFn: async (agentId: string): Promise<AgentProfile> =>
      (
        await duplicateBot(organizationId(), agentId, once(), {
          fallback: FALLBACK,
        })
      ).bot,
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      const write = variables.hidden ? hideBot : unhideBot;
      await write(organizationId(), variables.agentId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; pinned: boolean }) => {
      const write = variables.pinned ? pinBot : unpinBot;
      await write(organizationId(), variables.agentId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Every Bot delete, so what reads a Bot can tell it is being deleted from this browser. */
export const deleteAgentMutationKey = [...agentKeys.all, "delete"] as const;

/**
 * Delete a Bot. What was read of it (the Bot itself, its handoffs) stops existing with it, so it is
 * removed rather than read again: a read would ask for a Bot that is gone and answer 404, which the
 * Bot's page, still up while the list of Bots is read again, used to do on its way back to Bots.
 * Every other Bot read is refreshed.
 */
export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: deleteAgentMutationKey,
    mutationFn: async (agentId: string) => {
      await deleteBot(organizationId(), agentId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: async (_result, agentId) => {
      // Each of one Bot's reads is keyed ["agents", <read>, <Bot id>].
      const ofThisBot = {
        queryKey: agentKeys.all,
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[2] === agentId,
      };
      // A read of it already on its way is dropped too, not left to land in the cache.
      await queryClient.cancelQueries(ofThisBot);
      queryClient.removeQueries(ofThisBot);
      // How it worked goes with it, and the agents it used now count one Bot fewer.
      const itsDelegation = { queryKey: botAgentKeys.delegation(agentId) };
      await queryClient.cancelQueries(itsDelegation);
      queryClient.removeQueries(itsDelegation);
      void queryClient.invalidateQueries({ queryKey: botAgentKeys.list() });
      return queryClient.invalidateQueries({
        queryKey: agentKeys.all,
        predicate: (query) => query.queryKey[2] !== agentId,
      });
    },
  });
}

/**
 * Issue this Bot a credential for calling tools back, and hand it over once.
 *
 * The token is in this response and nowhere else, ever again, so the caller has to show it to the
 * person immediately. Calling this on a Bot that already has one rotates it, which is how a leaked
 * token is retired.
 */
export function issueCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string): Promise<string> =>
      (
        await issueBotCallbackToken(organizationId(), agentId, once(), {
          fallback: FALLBACK,
        })
      ).token,
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Take the credential away. The Bot may still talk; it may not reach anything outside a chat. */
export function revokeCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await revokeBotCallbackToken(organizationId(), agentId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same grant every other grant is (replaceBotGrant, deleteBotGrant), addressed `bot:<Bot id>`,
 * so the audit row and the refusals are the ones already in place: an administrator only, never a
 * Bot on itself, and never onto a Bot that does not exist.
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
      const grant = {
        kind: "bot" as const,
        ref: variables.ref,
        agentId: variables.agentId,
      };
      if (variables.granted) {
        await grantPlugin(grant);
        return;
      }
      await revokePlugin(grant);
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
