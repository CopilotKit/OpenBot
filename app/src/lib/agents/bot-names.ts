import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { type AgentProfile, agentListQueryOptions } from "./queries";

/**
 * Bot ids to the names people know them by, for the screens that are handed an id: Activity, Audit
 * and the computers page.
 *
 * A person never reads an id. A Bot they hid from the sidebar is still theirs and is named; one that
 * is gone reads as {@link GONE_BOT}, the words a conversation uses for the same thing; and until the
 * names arrive a Bot is named nothing rather than its id for a moment. The id stays in the CSV
 * export, which is where somebody reconciling the trail reads it.
 */
export const GONE_BOT = "A Bot no longer here";

/** Stable query selector so the id-to-name map only rebuilds when the roster changes. */
const toNames = (agents: AgentProfile[]): Map<string, string> =>
  new Map(agents.map((agent) => [agent.id, agent.name]));

export function useBotNames(): (botId: string) => string {
  const shown = useQuery({ ...agentListQueryOptions(), select: toNames });
  const hidden = useQuery({ ...agentListQueryOptions(true), select: toNames });
  // A hidden list that failed to load is no reason to name nobody; the shown list is the roster.
  const settled =
    shown.data !== undefined && (hidden.data !== undefined || hidden.isError);

  return useCallback(
    (botId: string) =>
      shown.data?.get(botId) ??
      hidden.data?.get(botId) ??
      (settled ? GONE_BOT : ""),
    [shown.data, hidden.data, settled],
  );
}
