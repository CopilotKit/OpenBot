import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
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

export function updateAgentAvatarMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      image: string | null;
    }): Promise<AgentProfile> =>
      client(`/api/agents/${variables.agentId}/avatar`, "agent", {
        method: "PUT",
        body: { image: variables.image },
        fallback: "Could not save the coworker avatar",
      }),
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
      client(`/api/agents/${agentId}/callback-token`, "token", {
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
      await client(`/api/agents/${agentId}/callback-token`, {
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
