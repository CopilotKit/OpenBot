import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useActiveSkin } from "@/skins/registry";

/*
 * Screens that only a skin has (OpenDuet's Tasks, OpenMuse's Ideas) live here, so a skin adds
 * screens without adding routes. Switching to a skin without this screen, or following an old link
 * to it, goes home rather than to an empty page.
 */
export const Route = createFileRoute("/_authed/_app/s/$screen")({
  component: RouteComponent,
});

function RouteComponent() {
  const { screen } = Route.useParams();
  const Screen = useActiveSkin().screens?.[screen];

  if (!Screen) return <Navigate replace to="/" />;

  return <Screen />;
}
