import { createFileRoute } from "@tanstack/react-router";
import { NewRoutinePage } from "@/components/routines/new-routine-page";
import { searchTextEntry } from "@/lib/search-text";

/**
 * New routine. Its own screen rather than a dialog over the list, as every several-field create is.
 *
 * `?agentId=` comes from a Bot's Routines page, and `?agentId=&channelId=` from the clock beside a
 * conversation's message box, so the routine starts out for that Bot and posts where it was asked.
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

function NewRoutineRoute() {
  const { agentId, channelId } = Route.useSearch();
  return <NewRoutinePage agentId={agentId} channelId={channelId} />;
}
