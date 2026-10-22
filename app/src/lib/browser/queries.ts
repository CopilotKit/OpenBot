import {
  type BrowserApiState,
  browserApiPaths,
} from "@openbot/shared/openbot-browser";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const browserKeys = {
  all: ["browser"] as const,
  state: ["browser", "state"] as const,
};

/** How often the Browser page asks again, the same once a second the computer's control state is read. */
export const BROWSER_POLL_MS = 1000;

/**
 * How often the sidebar asks while the person's browser is closed. Opening it from the sidebar asks again at once, so
 * this only catches a browser opened somewhere else: another of the person's OpenBot windows, or the Browser page.
 */
export const BROWSER_CLOSED_POLL_MS = 30_000;

/**
 * How often the sidebar asks, from what it last heard. Every second while the browser is open, so a Record pressed in
 * the Recorder's own toolbar button puts the red dot on the Browser button within about two seconds; rarely while it
 * is closed; never where OpenBot cannot run one, where there is no button to update. Asking never starts a computer:
 * the server answers a browser whose computer is not running as closed.
 */
function sidebarInterval(state: BrowserApiState | undefined): number | false {
  if (!state?.available) return false;
  return state.open ? BROWSER_POLL_MS : BROWSER_CLOSED_POLL_MS;
}

/**
 * The signed-in person's own browser: whether OpenBot can run one for them at all (`available`), where it shows
 * (`shows`), whether it is open, its tabs, and the Recorder's own report of what it is recording.
 *
 * The sidebar reads it to decide whether the Browser button shows, what a click on it does, and whether a recording is
 * running (`sidebarInterval`); the Browser page passes `poll` and reads it every second while it is open, because the
 * recording's action count and the tabs change in the browser, not here. One key for both, so the button and the page
 * never disagree about whether there is a browser.
 */
export function browserStateQueryOptions(options?: { poll?: boolean }) {
  return queryOptions({
    queryKey: browserKeys.state,
    // The whole body is the state, so no envelope key: without one, client() returns the Response.
    queryFn: async (): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.state, {
          fallback: "Couldn't load your browser.",
        })
      ).json(),
    refetchInterval: options?.poll
      ? BROWSER_POLL_MS
      : (query) => sidebarInterval(query.state.data),
  });
}
