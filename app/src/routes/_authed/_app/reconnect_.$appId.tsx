import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import { addDirectoryAppMutationOptions } from "@/lib/apps/mutations";
import {
  appsQueryOptions,
  catalogueQueryOptions,
  directoryAppsQueryOptions,
} from "@/lib/apps/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { cloudAppFor } from "@/lib/moves/moved-apps";
import { markReconnectReturn, useMovedApps } from "@/lib/moves/use-moved-apps";
import { queryClient } from "@/query-client";

/**
 * Connect one moved app again: remembers the reconnect list as where to come back to, then opens
 * the app's own page here, which offers the way back and takes the person back once it is connected.
 * The page starts the connect as it opens: the sign-in, or the key form. So Reconnect is one press,
 * never Reconnect and then the page's own Connect.
 *
 * `$appId` is the app as the move named it, which is not always its id here (`cloudAppFor`). An app
 * the organization hasn't added yet is added first when the person may add apps (an admin): from the
 * directory, as the directory's own page does, when the directory lists it. One the directory
 * doesn't list, nor OpenBot's own catalogue, is a server the person added by its address on their
 * computer: the admin goes to Add custom MCP with its name filled in, and comes back to the list once
 * it's added. Anybody else, or an add that is refused, goes back to the list, whose row says what is
 * needed. Never an "App not found" page, and never home.
 *
 * A plain path with no search, because OpenBot Desktop opens it too, straight from its move screen,
 * and Desktop opens only plain paths. The list's Reconnect buttons use the same path.
 */
export const Route = createFileRoute("/_authed/_app/reconnect_/$appId")({
  component: ReconnectOne,
});

function ReconnectOne() {
  const { appId } = Route.useParams();
  React.useState(() => markReconnectReturn(appId));
  const navigate = useNavigate();
  const apps = useQuery(appsQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  const moved = useMovedApps();
  const add = useMutation(addDirectoryAppMutationOptions(queryClient));
  const started = React.useRef(false);

  const here = apps.data ? cloudAppFor(appId, apps.data) : undefined;
  const admin = isOrganizationAdmin(user.data?.role);
  // The move's name for it, which the directory is searched by, and which the form fills in.
  const name = moved.apps.find((app) => app.appId === appId)?.appName ?? appId;
  // Asked only of an admin about to add an app the organization hasn't: is it one OpenBot lists?
  const lookUp = apps.isSuccess && !here && admin && moved.ready;
  const directory = useQuery({
    ...directoryAppsQueryOptions(name),
    enabled: lookUp,
  });
  const catalogue = useQuery({ ...catalogueQueryOptions(), enabled: lookUp });

  React.useEffect(() => {
    if (started.current || apps.isPending || user.isPending) return;
    const back = () =>
      void navigate({
        to: "/reconnect",
        search: { notAdded: appId },
        replace: true,
      });
    // With the connect started on arrival (`?connect=true`): one Reconnect is the whole press.
    const open = (key: string) =>
      void navigate({
        to: "/connections/$key",
        params: { key },
        search: { connect: true },
        replace: true,
      });
    if (apps.error) {
      started.current = true;
      return back();
    }
    if (here) {
      started.current = true;
      return open(here.id);
    }
    if (!admin) {
      started.current = true;
      return back();
    }
    if (!moved.ready || directory.isPending || catalogue.isPending) return;
    started.current = true;
    if (directory.error || catalogue.error) return back();
    const listed =
      directory.data.some((entry) => entry.id === `directory:${appId}`) ||
      (catalogue.data ?? []).some((entry) => entry.key === appId);
    if (!listed)
      return void navigate({
        to: "/connections/new",
        search: { title: name, reconnect: appId },
        replace: true,
      });
    add.mutate(
      { directoryEntryId: `directory:${appId}` },
      { onSuccess: open, onError: back },
    );
  }, [
    apps,
    user,
    moved.ready,
    directory,
    catalogue,
    here,
    admin,
    name,
    add,
    appId,
    navigate,
  ]);

  return <PageShell title="Reconnect your apps">{null}</PageShell>;
}
