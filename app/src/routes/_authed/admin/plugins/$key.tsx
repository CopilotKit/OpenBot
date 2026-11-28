import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
   *
   * `?connect=true` starts connecting on arrival: a card's Connect or Reconnect the shared account
   * opens this page with it, so that press is the whole of it. Read once and dropped, so a reload, or
   * coming back from the sign-in, does not start it again.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { add?: "instance" | "token"; reconnect?: string; connect?: true } => ({
    ...(search.add === "instance" || search.add === "token"
      ? { add: search.add }
      : {}),
    ...searchTextEntry("reconnect", search.reconnect),
    ...(search.connect === true || search.connect === "true"
      ? { connect: true as const }
      : {}),
  }),
});

function RouteComponent() {
  const { key } = Route.useParams();
  const { add, reconnect, connect } = Route.useSearch();
  const navigate = useNavigate();
  // Held for this visit, keyed on the app, and dropped from the address below.
  const [arrival] = useState(() => ({ key, connect: connect === true }));
  useEffect(() => {
    if (connect === undefined) return;
    void navigate({
      to: "/admin/plugins/$key",
      params: { key },
      search: ({ connect: _c, ...rest }) => rest,
      replace: true,
    });
  }, [connect, key, navigate]);
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
      startConnect={arrival.key === key && arrival.connect}
    />
  );
}
