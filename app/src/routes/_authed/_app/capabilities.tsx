import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Skills and memory under one address. Each tab draws its own frame through `CapabilitiesShell`; see
 * there for why the heading is not drawn here.
 */
export const Route = createFileRoute("/_authed/_app/capabilities")({
  component: Outlet,
});
