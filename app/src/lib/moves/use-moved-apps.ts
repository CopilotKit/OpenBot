import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { appsQueryOptions, catalogueQueryOptions } from "@/lib/apps/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useAppsOpen } from "@/lib/enterprise/apps-open";
import {
  connectionsQueryOptions,
  personalConnections,
} from "@/lib/plugins/queries";
import {
  dismissNoticeMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import {
  cloudAppFor,
  type MovedApp,
  movedApps,
  movedAppsInView,
  needsNoAccountOfYours,
} from "./moved-apps";
import { importListQueryOptions } from "./queries";

/**
 * The apps the person's moves left to connect again, as the screens draw them.
 *
 * `ready` once every read it needs has answered: their moves, and where a move listed apps, their
 * own connections and their preferences. Until then `apps` is empty, so nothing is drawn and nothing
 * flashes on and off. A failed preferences read counts as nothing dismissed: showing an app they
 * dismissed is the smaller harm than hiding one they still need.
 *
 * Their connections are asked only where a move listed something, so an OpenBot nobody moved to
 * asks nothing more than the one read of the moves.
 *
 * THE MOVES ARE ASKED ONLY OF A HOSTED OPENBOT. Only OpenBot Cloud takes a move, and it is the
 * OpenBot people sign in to with their account with OpenBot by CopilotKit (`hostedSignIn`). Every
 * other OpenBot answers listImports with 404, which reads as none but is still a failed request on
 * every page this frame draws, so a self-hosted OpenBot or the personal edition is never asked.
 */
export function useMovedApps() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const takesMoves = capabilities.data?.hostedSignIn === true;
  const imports = useQuery({
    ...importListQueryOptions(),
    enabled: takesMoves,
  });
  const listed = movedApps(takesMoves ? (imports.data ?? []) : []);
  const any = listed.length > 0;
  const connections = useQuery({ ...connectionsQueryOptions(), enabled: any });
  // Which app each one is here: a move names an app as the computer knew it (`cloudAppFor`).
  const cloudApps = useQuery({ ...appsQueryOptions(), enabled: any });
  // How each catalogue app is reached, which says whether it needs an account of the person's.
  const catalogue = useQuery({ ...catalogueQueryOptions(), enabled: any });
  const preferences = useUserPreferences();
  const user = useQuery(currentUserQueryOptions());
  const open = useAppsOpen();
  const dismiss = useMutation(
    dismissNoticeMutationOptions(queryClient, preferences.userId),
  );

  const connected = new Set(
    personalConnections(connections.data?.connections ?? [])
      // A withdrawn account is not connected: it is one more to connect again.
      .filter((row) => row.revoked !== true)
      .map((row) => row.serverId),
  );
  const cloudIdOf = (appId: string) =>
    cloudAppFor(appId, cloudApps.data ?? [])?.id;
  /*
   * Done once it is here, for an app that needs no account of the person's: what listApps says of
   * it, and for a catalogue app what the catalogue says of how it is reached. A catalogue that
   * couldn't be read says nothing, so such an app waits for the person's own connection.
   */
  const doneHere = (cloudId: string) => {
    const app = (cloudApps.data ?? []).find((each) => each.id === cloudId);
    const entry = (catalogue.data ?? []).find((item) => item.key === cloudId);
    return app !== undefined && needsNoAccountOfYours(app, entry?.auth);
  };
  // Settled once the deployment has answered (an answer that failed reads as not hosted, as every
  // capability does) and, where it takes moves, the moves have.
  const ready =
    !capabilities.isPending &&
    (!takesMoves || imports.isSuccess) &&
    (!any ||
      (connections.isSuccess &&
        cloudApps.isSuccess &&
        (catalogue.isSuccess || catalogue.isError) &&
        (preferences.isSuccess || preferences.isError)));
  const apps: MovedApp[] = ready
    ? movedAppsInView(
        listed,
        cloudIdOf,
        connected,
        preferences.data?.dismissedNotices ?? [],
        doneHere,
      )
    : [];
  const reads = [imports, connections, cloudApps];

  return {
    ready,
    /** A read that failed: the moves, the apps here, or the connections that say which are done. */
    error: reads.find((read) => read.error)?.error ?? null,
    retry: () => {
      for (const read of reads) if (read.error) void read.refetch();
    },
    retrying: reads.some((read) => read.isFetching),
    /**
     * Whether the person may add an app the organization hasn't yet (createApp), as on the
     * directory's own page: an admin, or anybody while apps are open.
     */
    mayAdd: isOrganizationAdmin(user.data?.role) || open === true,
    cloudIdOf,
    /** Whether any finished move listed an app at all, dismissed or not. */
    listedAny: listed.length > 0,
    apps,
    /** The ones still to connect again. */
    remaining: apps.filter((app) => !app.reconnected),
    connected,
    /** Whether the app here with this id needs no account of the person's, so it's done. */
    doneHere,
    dismiss: (app: MovedApp) => dismiss.mutate(app.noticeId),
    dismissing: dismiss.isPending ? dismiss.variables : undefined,
    dismissError: dismiss.error,
  };
}

/**
 * WHERE THE RECONNECT LIST SENDS SOMEBODY AND EXPECTS THEM BACK.
 *
 * `/reconnect/<appId>` records the app here before it opens the app's page, so the page knows to
 * offer the way back and to take the person back once the app is connected. The session's storage,
 * so it lasts across the vendor's sign-in (which leaves OpenBot and comes back) and is gone with
 * the tab. Storage can be refused (a private window, a blocked site): then there is simply no way
 * back offered, and the app page works as it always has.
 */
const RETURN_KEY = "openbot:reconnect-return";

export function markReconnectReturn(appId: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, appId);
  } catch {
    // No storage: no way back is offered. See above.
  }
}

export function reconnectReturn(): string | null {
  try {
    return sessionStorage.getItem(RETURN_KEY);
  } catch {
    return null;
  }
}

export function clearReconnectReturn(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Nothing was kept.
  }
}

/**
 * Takes the person back to the reconnect list once the app they left it for is connected: on that
 * app's page (where OpenBot Desktop's window stays through the sign-in) and on Connections (where a
 * browser's sign-in can come back). Home instead when that was the last app to connect.
 *
 * Connected means the person's own connections have it, read from the server, or, for an app that
 * needs no account of theirs, that the organization has it (`needsNoAccountOfYours`). A sign-in
 * that failed (`?connected=failed`) adds nothing there, so it never takes them back: they stay
 * where the failure is said, and the list is one press away.
 *
 * The way back is kept as the moved app's id, as the move named it. Answers the id of the app it is
 * here, the one its page is at, so that page can offer the way back.
 */
export function useReturnToReconnectList(): string | null {
  const [pending] = useState(reconnectReturn);
  const moved = useMovedApps();
  const navigate = useNavigate();
  const cloudId =
    pending === null ? null : (moved.cloudIdOf(pending) ?? pending);
  const done =
    cloudId !== null &&
    moved.ready &&
    (moved.connected.has(cloudId) || moved.doneHere(cloudId));
  const remaining = moved.remaining.filter((app) => app.appId !== pending);
  const home = remaining.length === 0;
  useEffect(() => {
    if (!done) return;
    clearReconnectReturn();
    void navigate({ to: home ? "/" : "/reconnect", replace: true });
  }, [done, home, navigate]);
  return cloudId;
}
