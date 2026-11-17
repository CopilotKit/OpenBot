import { useQuery } from "@tanstack/react-query";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { type MergedRoutine, mergeRoutines } from "./merged";
import { routinesQueryOptions } from "./queries";

/**
 * The three reads every kind of routine already has (routines, goals, check-ins), merged into one
 * list of rows (`merged.ts`), with the Bots those rows belong to. Scoped by `agentId` to one Bot's,
 * unscoped to all of the person's. One query per kind either way: each is owner-scoped and small,
 * so the scope is a filter here.
 */
export function useMergedRoutines(agentId?: string): {
  rows: MergedRoutine[];
  /** Names and faces for each row's Bot, hidden Bots included: a routine outlives hiding its Bot. */
  bots: Map<string, AgentProfile>;
  pending: boolean;
  /** The first read's error, or null. */
  error: Error | null;
  /** Which reads failed, as the list says it: "routines", "goals", "check-ins". */
  failed: string[];
  /** Whether the routines read failed, so a goal's row does not claim it has no starts. */
  routinesFailed: boolean;
} {
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  /* Names and faces for each row's Bot, hidden Bots included: a routine outlives hiding its Bot. */
  const shownBots = useQuery(agentListQueryOptions());
  const hiddenBots = useQuery({
    ...agentListQueryOptions(true),
    enabled: agentId === undefined,
  });
  const bots = new Map(
    [...(shownBots.data ?? []), ...(hiddenBots.data ?? [])].map((bot) => [
      bot.id,
      bot,
    ]),
  );

  const rows = mergeRoutines({
    routines: routines.data?.routines ?? [],
    goals: goals.data ?? [],
    checkIns: checkIns.data ?? [],
    agentId,
  });
  const failed = [
    routines.error ? "routines" : null,
    goals.error ? "goals" : null,
    checkIns.error ? "check-ins" : null,
  ].filter((name): name is string => name !== null);

  return {
    rows,
    bots,
    pending: routines.isPending || goals.isPending || checkIns.isPending,
    error: routines.error ?? goals.error ?? checkIns.error ?? null,
    failed,
    routinesFailed: routines.error !== null,
  };
}
