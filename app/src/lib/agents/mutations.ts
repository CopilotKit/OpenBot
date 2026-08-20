import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type AgentProfile, type AgentVisibility, agentKeys } from "./queries";

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
};

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Coworker operation failed";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AgentInput): Promise<AgentProfile> =>
      client("/api/agents", "agent", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      client(`/api/agents/${variables.agentId}`, "agent", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`/api/agents/${agentId}/duplicate`, "agent", {
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
        `/api/agents/${variables.agentId}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(`/api/agents/${agentId}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
