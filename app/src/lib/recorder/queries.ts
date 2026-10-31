import type { RecorderConnectionsResponse } from "@openbot/shared/recorder-api";
import { recorderPaths } from "@openbot/shared/recorder-api";
import { queryOptions } from "@tanstack/react-query";
import { BROWSER_CLOSED_POLL_MS, BROWSER_POLL_MS } from "@/lib/browser/queries";
import { client } from "@/lib/client";
import {
  askConnectWait,
  type ConnectWait,
  findRecorderHere,
  type RecorderHere,
} from "./bridge";

export const recorderKeys = {
  all: ["recorder"] as const,
  connections: () => ["recorder", "connections"] as const,
  /** The Recorder in the browser OpenBot is open in. Asked of the browser, never of the server. */
  here: () => ["recorder", "here"] as const,
  /** Where one connect, by when it started, has got to on the Recorder's Connect page. Asked of the browser too. */
  connectWait: (id: string, since: number) =>
    ["recorder", "connect-wait", { id, since }] as const,
};

/**
 * How often Settings, Browsers asks again while it is open, as the other settings screens do: so a browser that starts
 * or stops recording, connects or is disconnected shows without a reload.
 */
export const CONNECTIONS_POLL_MS = 10_000;

/**
 * The browsers connected for this person, and the extension ids this OpenBot trusts.
 *
 * `awaiting` polls every 2 s while a "Connect this browser" request waits for the person to confirm
 * it in the Recorder's own tab; `listed`, every {@link CONNECTIONS_POLL_MS} while the list is on screen.
 */
export const recorderConnectionsQueryOptions = (options?: {
  awaiting?: boolean;
  listed?: boolean;
}) =>
  queryOptions({
    queryKey: recorderKeys.connections(),
    // Two top-level keys, so no envelope key: without one, client() returns the Response.
    queryFn: async (): Promise<RecorderConnectionsResponse> =>
      (
        await client(recorderPaths.connections, {
          fallback: "Couldn't load your connected browsers.",
        })
      ).json(),
    refetchInterval: options?.awaiting
      ? 2000
      : options?.listed
        ? CONNECTIONS_POLL_MS
        : false,
  });

/** How often the Browser button asks while a connect waits for the person to confirm it in the Recorder's own tab. */
const AWAITING_POLL_MS = 2000;

/**
 * How often the Browser button asks the Recorder in this browser, from its last answer: every second while it records,
 * so the red dot and the elapsed time follow it at once, and rarely otherwise, so an idle Recorder's service worker is
 * not kept awake for nothing. Where it is not here at all, only when the person comes back to OpenBot's tab
 * (`refetchOnWindowFocus`), which is when they will have added it from its store page.
 */
function hereInterval(
  here: RecorderHere | undefined,
  awaiting: boolean,
): number | false {
  if (here?.kind === "connected")
    return here.state.phase === "idle"
      ? BROWSER_CLOSED_POLL_MS
      : BROWSER_POLL_MS;
  if (here?.kind === "unconnected")
    return awaiting ? AWAITING_POLL_MS : BROWSER_CLOSED_POLL_MS;
  return false;
}

/**
 * The Recorder in the browser OpenBot is open in (`findRecorderHere`), asked of the browser itself over
 * `externally_connectable`, among `ids`, the Recorder ids this OpenBot trusts. A query rather than a plain function
 * because it is read on a schedule and re-read after Record, Stop and Connect, as the server's state is; it never
 * throws, because every answer, the Recorder's absence included, is something the button shows.
 *
 * `awaiting` asks every 2 s while a connect waits for the person to confirm it in the Recorder's own tab.
 */
export const recorderHereQueryOptions = (
  ids: readonly string[],
  options?: { awaiting?: boolean },
) =>
  queryOptions({
    queryKey: recorderKeys.here(),
    queryFn: (): Promise<RecorderHere> => findRecorderHere(ids),
    refetchInterval: (query) =>
      hereInterval(query.state.data, options?.awaiting ?? false),
    // Unlike the app's server reads (query-client.ts), asked again whenever the person comes back to the tab: it costs
    // no request, and it is how the button finds a Recorder they have just added, connected, or pressed Record in.
    refetchOnWindowFocus: true,
  });

/** How often a page waiting on the Recorder's Connect page asks where its connect has got to. */
const CONNECT_WAIT_POLL_MS = 1000;

/**
 * Where the connect this page started at `since` has got to on the Recorder `id`'s Connect page (`askConnectWait`):
 * asked every second while the page waits, and again the moment the person comes back to this tab, which is when they
 * will have pressed Cancel there or closed it, so the page says so at once rather than when the request runs out. Keyed
 * by when the connect started, so what was said of an earlier one is never read for the next.
 */
export const recorderConnectWaitQueryOptions = (id: string, since: number) =>
  queryOptions({
    queryKey: recorderKeys.connectWait(id, since),
    queryFn: (): Promise<ConnectWait> => askConnectWait(id),
    refetchInterval: CONNECT_WAIT_POLL_MS,
    // Asking costs no request, unlike the app's server reads (query-client.ts).
    refetchOnWindowFocus: true,
  });
