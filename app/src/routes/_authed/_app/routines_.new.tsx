import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { NewRoutinePage } from "@/components/routines/new-routine-page";
import type { RoutineDraft } from "@/lib/api/generated/model";
import { searchTextEntry } from "@/lib/search-text";

/**
 * New routine. Its own screen rather than a dialog over the list, as every several-field create is.
 *
 * `?agentId=` comes from a Bot's Routines page, and `?agentId=&channelId=` from the clock beside a
 * conversation's message box, so the routine starts out for that Bot and posts where it was asked.
 * The Routines box passes what it read from a sentence in navigation state, not in the address: a
 * reload has none, and shows the form with only the Bot chosen.
 */
export const Route = createFileRoute("/_authed/_app/routines_/new")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { agentId?: string; channelId?: string } => ({
    ...searchTextEntry("agentId", search.agentId),
    ...searchTextEntry("channelId", search.channelId),
  }),
  component: NewRoutineRoute,
});

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set by the Routines box: what it read from a sentence, to open New routine filled in. */
    routineDraft?: RoutineDraft;
  }
}

function NewRoutineRoute() {
  const { agentId, channelId } = Route.useSearch();
  const draft = useRouterState({
    select: (s) => s.location.state.routineDraft,
  });
  return (
    <NewRoutinePage agentId={agentId} channelId={channelId} draft={draft} />
  );
}
