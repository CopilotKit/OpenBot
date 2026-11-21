import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/Agentes/Legado-routes";

/** Groups are started from the new-conversation screen, with two or more Bots in To:. */
export const Route = createFileRoute("/_authed/_app/Grupo/new")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/Grupo/new"], replace: true });
  },
});
