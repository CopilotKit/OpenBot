import { useQuery } from "@tanstack/react-query";
import { useDeletedHere } from "@/components/routines/routine-detail-missing";
import { deleteAgentMutationKey } from "@/lib/agents/mutations";
import { agentQueryOptions } from "@/lib/agents/queries";
import { botDelegationQueryOptions } from "@/lib/bot-agents/queries";
import { botActivityQueryOptions } from "@/lib/bot-lifecycle/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";

/**
 * A Bot, what it is doing and which apps it holds, read until the Bot is deleted from this browser.
 *
 * A Bot's page stays up for a moment after a delete: the delete waits for the list of Bots to be
 * read again, and only then goes back to Bots. A read in that moment asks about a Bot that is gone
 * and is answered 404. So from the moment a delete of this Bot is on its way, these are not read:
 * the delete drops what was read of the Bot (`deleteAgentMutationOptions`), and nothing here asks
 * again, the polls of its activity and its apps included.
 */
function useBotDeletedHere(agentId: string) {
  return useDeletedHere<string>(deleteAgentMutationKey, (id) => id === agentId);
}

export function useBot(agentId: string) {
  const deleted = useBotDeletedHere(agentId);
  return useQuery({ ...agentQueryOptions(agentId), enabled: !deleted });
}

export function useBotActivity(agentId: string) {
  const deleted = useBotDeletedHere(agentId);
  return useQuery({ ...botActivityQueryOptions(agentId), enabled: !deleted });
}

export function useBotPlugins(agentId: string) {
  const deleted = useBotDeletedHere(agentId);
  return useQuery({
    ...agentPluginsQueryOptions(agentId),
    enabled: agentId.length > 0 && !deleted,
  });
}

/** How the Bot works and the agents it may use, read until the Bot is deleted from this browser. */
export function useBotDelegation(agentId: string) {
  const deleted = useBotDeletedHere(agentId);
  return useQuery({
    ...botDelegationQueryOptions(agentId),
    enabled: agentId.length > 0 && !deleted,
  });
}
