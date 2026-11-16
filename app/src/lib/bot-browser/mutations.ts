import type { BotBrowserApiState } from "@openbot/shared/bot-browser";
import type {
  BrowserNavigateRequest,
  BrowserTabsRequest,
} from "@openbot/shared/openbot-browser";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  changeBotBrowserTabs,
  clearBotBrowser,
  narrateInBotBrowser,
  navigateBotBrowser,
  recordInBotBrowser,
} from "@/lib/api/generated/browsers/browsers";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import {
  type NarrationAnswer,
  type NarrationPost,
  sendNarrationWith,
} from "@/lib/browser/mutations";
import { botBrowserKeys } from "./queries";

/*
 * WRITES TO A BOT'S BROWSER, by the person holding its wheel. The server refuses each of them (409, with its own
 * sentence) to anyone else, so these carry no rule of their own about who may: the app shows the server's sentence.
 *
 * Each factory is for one Bot, as the screen it is pressed in is: the request bodies are then exactly the person's own
 * browser's, which is what lets the Bot's screen share the bar and the Record controls with the Browser page.
 */

function invalidateBotBrowser(queryClient: QueryClient, botId: string) {
  return queryClient.invalidateQueries({
    queryKey: botBrowserKeys.state(botId),
  });
}

/**
 * Starts recording the tab the person is on in the Bot's browser, named for the task, for the person alone.
 *
 * Whether they narrate is not passed on: a Bot's browser is narrated from this page (`external`), whose microphone opens
 * only by the person's choice (`useNarration`), and the Recorder there has no microphone to open.
 */
export function startBotBrowserRecordingMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: (variables: {
      title: string;
      language?: string;
    }): Promise<BotBrowserApiState> =>
      recordInBotBrowser(
        organizationId(),
        botId,
        {
          action: "start",
          title: variables.title,
          ...(variables.language ? { language: variables.language } : {}),
        },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't start recording. Try again." },
      ),
    onSuccess: () => invalidateBotBrowser(queryClient, botId),
  });
}

/**
 * Stops the person's recording. Read again on a refusal as well as on success: the one refusal there is, a recording
 * that is not theirs or not running, means the computer ended it under them (the wheel went back), and the read is what
 * says so.
 */
export function stopBotBrowserRecordingMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: (): Promise<BotBrowserApiState> =>
      recordInBotBrowser(
        organizationId(),
        botId,
        { action: "stop" },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't stop recording. Try again." },
      ),
    onSettled: () => invalidateBotBrowser(queryClient, botId),
  });
}

/** A new tab, or switching to or closing one, in the Bot's browser. */
export function botBrowserTabsMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: (request: BrowserTabsRequest): Promise<BotBrowserApiState> =>
      changeBotBrowserTabs(
        organizationId(),
        botId,
        request,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't change the tabs. Try again." },
      ),
    onSuccess: () => invalidateBotBrowser(queryClient, botId),
  });
}

/** An address typed into the bar, or back, forward or reload, in the tab the person is on in the Bot's browser. */
export function navigateBotBrowserMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: (
      request: BrowserNavigateRequest,
    ): Promise<BotBrowserApiState> =>
      navigateBotBrowser(
        organizationId(),
        botId,
        request,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't open that page. Try again." },
      ),
    onSuccess: () => invalidateBotBrowser(queryClient, botId),
  });
}

/**
 * Wipes the Bot's browser for the person holding its wheel: cookies, saved passwords, history and site storage, which
 * signs it out of everything. The answer is the fresh browser, started again under them.
 */
export function clearBotBrowserMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: (): Promise<BotBrowserApiState> =>
      clearBotBrowser(
        organizationId(),
        botId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't clear the browser. Try again." },
      ),
    onSettled: () => invalidateBotBrowser(queryClient, botId),
  });
}

/**
 * One thing the person's narration says to the Recorder in the Bot's browser, exactly as `sendNarration` does for their
 * own: a plain function for the same reasons, answering rather than throwing.
 */
export function sendBotBrowserNarration(
  botId: string,
  post: NarrationPost,
): Promise<NarrationAnswer> {
  return sendNarrationWith(
    (narration, options) =>
      narrateInBotBrowser(
        organizationId(),
        botId,
        narration,
        { "Idempotency-Key": idempotencyKey() },
        options,
      ),
    post,
  );
}
