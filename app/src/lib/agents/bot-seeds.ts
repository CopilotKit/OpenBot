import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { type AgentProfile, agentListQueryOptions } from "./queries";

/** Stable query selector so the id-to-seed map only rebuilds when the roster changes. */
const toSeeds = (agents: AgentProfile[]): Map<string, string> =>
  new Map(agents.map((agent) => [agent.id, agent.avatarSeed]));

/**
 * Each Bot's face by its id: the seed it is drawn from, which its owner may have changed, so a list
 * that knows only ids still draws the face every other surface draws. A Bot this person's list
 * doesn't hold, such as a hidden one, falls back to its id, which was its seed until somebody
 * changed it. Null while the list is loading, so no face is drawn that is about to change.
 */
export function useBotSeeds(): ((botId: string) => string) | null {
  const { data: seeds, isPending } = useQuery({
    ...agentListQueryOptions(),
    select: toSeeds,
    // A face that mounts does not refetch a list already held: a sidebar mounts dozens. A changed
    // look still arrives, because a save invalidates the list.
    refetchOnMount: false,
  });
  const seedOf = useCallback(
    (botId: string) => seeds?.get(botId) ?? botId,
    [seeds],
  );
  return isPending ? null : seedOf;
}
