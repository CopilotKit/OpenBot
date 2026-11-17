import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import {
  createBotAgent,
  deleteBotAgent,
  issueBotAgentCallbackToken,
  replaceBotDelegation,
  revokeBotAgentCallbackToken,
  updateBotAgent,
} from "@/lib/api/generated/agents/agents";
import type {
  CreateBotAgentRequest,
  ReplaceBotDelegationRequest,
  UpdateBotAgentRequest,
} from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { type AgentRecord, botAgentKeys, type Delegation } from "./queries";

/** What an agent is added with, and changed with: the spec's own request bodies. */
export type AgentRecordInput = CreateBotAgentRequest;
export type AgentRecordChange = UpdateBotAgentRequest;
export type DelegationInput = ReplaceBotDelegationRequest;

/** A fresh key for each write a person asks for. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Couldn't save that change to the agent.";

/**
 * Server-derived fields are invalidated instead of patched by hand. A Bot reads its endpoint and
 * framework from its agent, so a change to an agent refreshes the Bots too.
 */
function invalidateAgents(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: botAgentKeys.all }),
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  ]);
}

export function createBotAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: AgentRecordInput): Promise<AgentRecord> =>
      (
        await createBotAgent(organizationId(), input, once(), {
          fallback: FALLBACK,
        })
      ).agent,
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function updateBotAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botAgentId: string;
      input: AgentRecordChange;
    }): Promise<AgentRecord> =>
      (
        await updateBotAgent(
          organizationId(),
          variables.botAgentId,
          variables.input,
          once(),
          { fallback: FALLBACK },
        )
      ).agent,
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Delete an agent. Refused while it is a Bot's only agent: the refusal carries the server's own
 * sentence (`BOT_AGENT_IN_USE`), which the screen shows as it is.
 */
export function deleteBotAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (botAgentId: string) => {
      await deleteBotAgent(organizationId(), botAgentId, once(), {
        fallback: "Couldn't delete the agent.",
      });
    },
    onSuccess: async (_result, botAgentId) => {
      queryClient.removeQueries({ queryKey: botAgentKeys.detail(botAgentId) });
      await invalidateAgents(queryClient);
    },
  });
}

/**
 * Issue this agent a credential for calling tools back, and hand it over once. Issuing on an agent
 * that has one rotates it, which is how a leaked token is retired.
 */
export function issueBotAgentCallbackTokenMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (botAgentId: string): Promise<string> =>
      (
        await issueBotAgentCallbackToken(organizationId(), botAgentId, once(), {
          fallback: FALLBACK,
        })
      ).token,
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Take the credential away. The agent may still answer; it may not reach anything outside a chat. */
export function revokeBotAgentCallbackTokenMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (botAgentId: string) => {
      await revokeBotAgentCallbackToken(organizationId(), botAgentId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Set how a Bot works: on its one agent, or handing work to the agents it may use. A Bot's endpoint,
 * framework and model choice follow from it, so the Bots are read again too.
 */
export function replaceBotDelegationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      botId: string;
      input: DelegationInput;
    }): Promise<Delegation> =>
      replaceBotDelegation(
        organizationId(),
        variables.botId,
        variables.input,
        once(),
        { fallback: "Couldn't save how this Bot works." },
      ),
    onSuccess: () => invalidateAgents(queryClient),
  });
}
