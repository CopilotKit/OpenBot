import {
  type BotBrowserApiState,
  botBrowserApiPaths,
} from "@openbot/shared/bot-browser";
import { queryOptions } from "@tanstack/react-query";
import { BROWSER_POLL_MS } from "@/lib/browser/queries";
import { client } from "@/lib/client";

export const botBrowserKeys = {
  all: ["bot-browser"] as const,
  state: (botId: string) => ["bot-browser", "state", botId] as const,
};

/**
 * A Bot's browser as a person working in it sees it: its tabs, the Recorder's own report, and the server's verdicts on
 * the signed-in person, whether they hold the wheel (`mine`, so the bar and Record are live for them) and whether the
 * recording running is theirs (`recordingIsMine`).
 *
 * Read every second while the Bot's screen is open full size, as the Browser page reads the person's own, because what
 * changes (where the Bot is, the tabs, a recording's actions, who holds the wheel) changes on the computer rather than
 * here. Reading it never launches the browser.
 */
export function botBrowserStateQueryOptions(botId: string) {
  return queryOptions({
    queryKey: botBrowserKeys.state(botId),
    // The whole body is the state, so no envelope key: without one, client() returns the Response.
    queryFn: async (): Promise<BotBrowserApiState> =>
      (
        await client(botBrowserApiPaths.state(botId), {
          fallback: "Couldn't load the Bot's browser.",
        })
      ).json(),
    refetchInterval: BROWSER_POLL_MS,
  });
}
