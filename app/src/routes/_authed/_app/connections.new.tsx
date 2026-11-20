import { createFileRoute } from "@tanstack/react-router";
import { AddServerPage } from "@/components/connections/add-server-page";

/** Connections, Add server: an MCP server added by its address. */
export const Route = createFileRoute("/_authed/_app/connections/new")({
  component: AddServerPage,
});
