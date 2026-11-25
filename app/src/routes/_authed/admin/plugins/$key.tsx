import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PluginPage } from "@/components/manage/plugin-page";
import { useDropBrokerReturn } from "@/lib/connections/broker-return";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
  /*
   * `?add=instance|token&reconnect=<appId>` is the list of apps to reconnect after a move opening a
   * catalogue entry the organization hasn't added, which needs its instance host or its access token
   * first: that form opens on arrival, and once the app is added the moved app's Reconnect goes on
   * from where it stopped (`/reconnect/<appId>`). Read as text, as every report here is.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { add?: "instance" | "token"; reconnect?: string } => ({
    ...(search.add === "instance" || search.add === "token"
      ? { add: search.add }
      : {}),
    ...searchTextEntry("reconnect", search.reconnect),
  }),
});

function RouteComponent() {
  const { key } = Route.useParams();
  const { add, reconnect } = Route.useSearch();
  const navigate = useNavigate();
  useDropBrokerReturn();
  return (
    <PluginPage
      onAdded={
        reconnect
          ? () =>
              void navigate({
                to: "/reconnect/$appId",
                params: { appId: reconnect },
                replace: true,
              })
          : undefined
      }
      pluginKey={key}
      startAdd={add}
    />
  );
}
