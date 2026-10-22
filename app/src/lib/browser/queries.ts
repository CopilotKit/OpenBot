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
 * The signed-in person's own browser: whether OpenBot can run one for them at all (`available`), whether it is open,
 * its tabs, and the Recorder's own report of what it is recording.
 *
 * The sidebar reads it once to decide whether the Browser button shows; the Browser page passes `poll` and reads it
 * every second while it is open, because the recording's action count and the tabs change in the browser, not here.
 * One key for both, so the button and the page never disagree about whether there is a browser.
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
    refetchInterval: options?.poll ? BROWSER_POLL_MS : false,
  });
}
