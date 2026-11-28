import { createFileRoute } from "@tanstack/react-router";
import { AddServerPage } from "@/components/connections/add-server-page";
import { searchTextEntry } from "@/lib/search-text";

/**
 * Connections, Add custom MCP: an MCP server added by its address.
 *
 * `?title=&reconnect=` is the list of apps to reconnect after a move opening it for a server the
 * person had added by its address on their computer (`/reconnect/<appId>`): the name filled in, and
 * the way back to that list. Read as text, as every report here is.
 */
export const Route = createFileRoute("/_authed/_app/connections/new")({
  component: ConnectionsAddServerPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { title?: string; reconnect?: string } => ({
    ...searchTextEntry("title", search.title),
    ...searchTextEntry("reconnect", search.reconnect),
  }),
});

function ConnectionsAddServerPage() {
  const { title, reconnect } = Route.useSearch();
  return <AddServerPage reconnect={reconnect} title={title} />;
}
