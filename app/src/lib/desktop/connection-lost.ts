import {
  onlineManager,
  type Query,
  type QueryClient,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  type DesktopConnection,
  desktopConnectionQueryOptions,
  desktopKeys,
} from "./queries";
import { openbotUnreachable, subscribeReachability } from "./reachability";
import { desktopShell } from "./shell";

/**
 * The connection line's moment: OpenBot Desktop connected to an OpenBot somewhere else, and that
 * OpenBot not answering (`reachability.ts`). While it lasts the line says why, once, and the screens
 * wait for OpenBot instead of each saying in red that its own read failed.
 *
 * HOW THE SCREENS WAIT. To TanStack Query this is being offline, and Query already knows how to be
 * offline: a read that would go out is paused, a read that failed is retried once the client is back
 * online, and every read on screen is asked again then (`refetchOnReconnect`). So while the
 * connection is lost the client is offline (`holdReadsWhileConnectionLost`), and a read that fails
 * because of it is retried rather than failed (`retryWhileConnectionLost`). A section is never told
 * its read failed for a cause the line already names; it keeps what it had, or waits as it does
 * while loading, and fills in by itself when OpenBot answers. Writes wait the same way, and go out
 * then.
 *
 * Only in connected mode, where the line shows. A browser whose server went away, and a local
 * Desktop, have no line, so there every section still says its own read failed.
 */

/** The address of the OpenBot this window is connected to, or null when it runs here or in a browser. */
function connectedAddress(client: QueryClient): string | null {
  const connection = client.getQueryData<DesktopConnection>(
    desktopKeys.connection,
  );
  return connection?.mode === "connected" ? connection.address : null;
}

/** True while the connection line shows: connected, and the OpenBot there did not answer. */
export function connectionLost(client: QueryClient): boolean {
  return openbotUnreachable() && connectedAddress(client) !== null;
}

/** The connection line's state for a component: the address, and whether it is lost now. */
export function useConnectionLost(): {
  lost: boolean;
  address: string | null;
} {
  const connection = useQuery(desktopConnectionQueryOptions());
  const unreachable = useSyncExternalStore(
    subscribeReachability,
    openbotUnreachable,
    () => false,
  );
  const address =
    connection.data?.mode === "connected" ? connection.data.address : null;
  return { lost: address !== null && unreachable, address };
}

const reconnected = new Set<() => void>();

/**
 * Called each time OpenBot answers again after the line showed. For what Query does not hold: a
 * conversation's transcript, which the conversation reads itself.
 */
export function useReconnected(listener: () => void): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    const call = () => latest.current();
    reconnected.add(call);
    return () => {
      reconnected.delete(call);
    };
  }, []);
}

/**
 * A query's retry rule, kept, with one exception: a read that failed while the connection is lost is
 * retried at once, which waits for the client to be online again before it goes out.
 */
export function retryWhileConnectionLost<TError>(
  client: QueryClient,
  retry: boolean | number | ((failureCount: number, error: TError) => boolean),
  retryDelay:
    | number
    | ((failureCount: number, error: TError) => number)
    | undefined,
): {
  retry: (failureCount: number, error: TError) => boolean;
  retryDelay: (failureCount: number, error: TError) => number;
} {
  return {
    retry: (failureCount, error) => {
      if (connectionLost(client)) return true;
      if (typeof retry === "function") return retry(failureCount, error);
      if (typeof retry === "number") return failureCount < retry;
      return retry;
    },
    retryDelay: (failureCount, error) => {
      if (connectionLost(client)) return 0;
      if (typeof retryDelay === "function")
        return retryDelay(failureCount, error);
      if (typeof retryDelay === "number") return retryDelay;
      // Query's own default.
      return Math.min(1000 * 2 ** failureCount, 30_000);
    },
  };
}

/** A read of OpenBot's that failed and still says so. */
function failed(query: Query): boolean {
  return (
    query.state.status === "error" && query.queryKey[0] !== desktopKeys.all[0]
  );
}

function isConnectionQuery(query: Query): boolean {
  const [scope, name] = desktopKeys.connection;
  return query.queryKey[0] === scope && query.queryKey[1] === name;
}

/**
 * Makes the client offline while the connection is lost, and online again when OpenBot answers.
 * Called once, for the app's one client.
 *
 * When the line appears, a read that had already failed is put back to waiting, so no section's
 * error is left under it. When it clears, the client is online again, which retries what was
 * waiting and asks again for every read on screen; a read that still says it failed is asked again
 * too, so no section keeps an error from while OpenBot was away.
 *
 * The desktop app's own commands are answered on this computer, so they never wait.
 */
export function holdReadsWhileConnectionLost(client: QueryClient): void {
  client.setQueryDefaults(desktopKeys.all, { networkMode: "always" });
  if (desktopShell() !== null)
    void client.prefetchQuery(desktopConnectionQueryOptions());

  onlineManager.setEventListener((setOnline) => {
    if (typeof window === "undefined") return;
    let browserOnline = true;
    let lost = false;
    const update = () => {
      const was = lost;
      lost = connectionLost(client);
      setOnline(browserOnline && !lost);
      if (lost && !was) void client.resetQueries({ predicate: failed });
      if (!lost && was) {
        void client.invalidateQueries({ predicate: failed });
        for (const listener of reconnected) listener();
      }
    };
    const online = () => {
      browserOnline = true;
      update();
    };
    const offline = () => {
      browserOnline = false;
      update();
    };
    window.addEventListener("online", online, false);
    window.addEventListener("offline", offline, false);
    const offReachability = subscribeReachability(update);
    const offCache = client.getQueryCache().subscribe((event) => {
      if (isConnectionQuery(event.query)) update();
    });
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      offReachability();
      offCache();
    };
  });
}
