import {
  type BrowserApiState,
  type BrowserNarrationRequest,
  type BrowserNavigateRequest,
  type BrowserOpenResponse,
  type BrowserTabsRequest,
  browserApiPaths,
  type RealBrowser,
  type RealBrowserOpenResponse,
} from "@openbot/shared/openbot-browser";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { computerKeys } from "@/lib/computers/queries";
import { browserKeys } from "./queries";

function invalidateBrowser(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: browserKeys.all });
}

/**
 * Opens the person's browser, or brings it forward when it is already open: a window on their desktop where a
 * host-side computer runs people's browsers, and elsewhere (hosted OpenBot, OpenBot Desktop) a browser the page shows. The answer says which, and names the computer the live screen
 * streams.
 *
 * With a host-side computer it may instead be the person's own everyday Chrome or Edge (`opened`): brought forward when the
 * Recorder in it is connected, or showing the Recorder's store page for them to add it.
 */
export function openBrowserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: openBrowser,
    onSuccess: () => invalidateBrowser(queryClient),
  });
}

async function openBrowser(): Promise<
  BrowserOpenResponse | RealBrowserOpenResponse
> {
  return (
    await client(browserApiPaths.open, {
      method: "POST",
      fallback: "Couldn't open your browser. Try again.",
    })
  ).json();
}

export type BrowserRecordingStart = {
  title: string;
  language?: string;
  /** Whether the person narrates this recording, as they chose: the Recorder opens a microphone only when true. */
  narrate?: boolean;
};

async function startBrowserRecording(
  variables: BrowserRecordingStart,
): Promise<BrowserApiState> {
  return (
    await client(browserApiPaths.recording, {
      method: "POST",
      body: {
        action: "start",
        title: variables.title,
        ...(variables.language ? { language: variables.language } : {}),
        ...(variables.narrate !== undefined
          ? { narrate: variables.narrate }
          : {}),
      },
      fallback: "Couldn't start recording. Try again.",
    })
  ).json();
}

/** Starts recording the tab the person is on, named for the task. `language` is the one narration is heard in. */
export function startBrowserRecordingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: startBrowserRecording,
    onSuccess: () => invalidateBrowser(queryClient),
  });
}

const REAL_BROWSER_NAMES: Record<RealBrowser, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
};

/**
 * What the person is told when Open put the Recorder's page in the store of their own browser, rather than opening a
 * browser with the Recorder in it: the page is there, in the browser named, and adding it is what lets them record in
 * that browser.
 */
export function storeOpenedSentence(browser: RealBrowser): string {
  return `The OpenBot Recorder's page is open in ${REAL_BROWSER_NAMES[browser]}. Add it there to record in your own browser.`;
}

/** What the person is told when Start recording found their own everyday browser rather than the one OpenBot opens:
 * OpenBot cannot start the Recorder there, so they start it with its own button. */
export const RECORD_THERE =
  "Your browser is open. Start recording with the Recorder's button in its toolbar.";

/**
 * Start recording where the browser is a window on the person's desktop: opens it, or brings it forward,
 * and starts recording in it, so the person is doing the task as soon as the window is in front of them. Open answers
 * once the Recorder in it is connected, so the start that follows finds it ready.
 *
 * Where Open brought forward the person's own everyday Chrome or Edge instead (`opened`), OpenBot cannot start the
 * Recorder in it: the person is told to press its button there.
 */
export function openAndStartBrowserRecordingMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (
      variables: BrowserRecordingStart,
    ): Promise<BrowserApiState> => {
      const opened = await openBrowser();
      if ("opened" in opened)
        throw new Error(
          opened.opened === "store"
            ? storeOpenedSentence(opened.browser)
            : RECORD_THERE,
        );
      return startBrowserRecording(variables);
    },
    onSettled: () => invalidateBrowser(queryClient),
  });
}

export function stopBrowserRecordingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.recording, {
          method: "POST",
          body: { action: "stop" },
          fallback: "Couldn't stop recording. Try again.",
        })
      ).json(),
    onSuccess: () => invalidateBrowser(queryClient),
  });
}

/** A new tab, or switching to or closing one, in the browser the page shows. */
export function browserTabsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (request: BrowserTabsRequest): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.tabs, {
          method: "POST",
          body: request,
          fallback: "Couldn't change the tabs. Try again.",
        })
      ).json(),
    onSuccess: () => invalidateBrowser(queryClient),
  });
}

/** An address typed into the address bar, or back, forward or reload, in the tab the person is on. */
export function navigateBrowserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      request: BrowserNavigateRequest,
    ): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.navigate, {
          method: "POST",
          body: request,
          fallback: "Couldn't open that page. Try again.",
        })
      ).json(),
    onSuccess: () => invalidateBrowser(queryClient),
  });
}

/**
 * Wipes the person's browser: cookies, saved passwords, history and site storage, which signs it out of everything. One
 * that was open opens again, fresh; the answer is the browser after it.
 */
export function clearBrowserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.clear, {
          method: "POST",
          fallback: "Couldn't clear your browser. Try again.",
        })
      ).json(),
    // Settings > Computer lists the browser too, with whether it runs.
    onSettled: () =>
      Promise.all([
        invalidateBrowser(queryClient),
        queryClient.invalidateQueries({ queryKey: computerKeys.fleet() }),
      ]),
  });
}

type Unsent<T> = T extends unknown ? Omit<T, "sentAt"> : never;
/** A narration post as the page makes it: `sentAt` is stamped as it leaves (`sendNarration`). */
export type NarrationPost = Unsent<BrowserNarrationRequest>;

/**
 * One thing the person's narration says to the Recorder in their browser: a phrase they said, with when they started
 * and stopped saying it, or that they began a phrase or stopped speaking.
 *
 * `sentAt` is this computer's clock as the post leaves, stamped here rather than by the caller: the server shifts every
 * time in it by its own clock on arrival minus `sentAt`, so a post that waited its turn must not carry the time it
 * was queued.
 *
 * A plain function rather than a mutation: nothing cached changes, and it is a step inside a recording rather than a
 * write somebody pressed a button for. It answers whether the post was taken, and when it was not, the server's own
 * sentence if it said one, instead of throwing, because that is told to the person beside the narration switch and the
 * recording carries on.
 */
export function sendNarration(post: NarrationPost): Promise<NarrationAnswer> {
  return sendNarrationTo(browserApiPaths.narration, post);
}

/** Whether a narration post was taken, and when it was not, the server's own sentence for why if it said one. */
export type NarrationAnswer =
  | { ok: true }
  | { ok: false; error: string | null };

/**
 * `sendNarration` to the narration route at `path`: the person's own browser's, or a Bot's browser's
 * (`lib/bot-browser`), which takes the same body and answers the same way.
 */
export async function sendNarrationTo(
  path: string,
  post: NarrationPost,
): Promise<NarrationAnswer> {
  try {
    const response = await tryClient(path, {
      method: "POST",
      body: { ...post, sentAt: Date.now() },
    });
    if (response.ok) return { ok: true };
    const said: unknown = await response
      .json()
      .then((body: { error?: unknown }) => body.error)
      .catch(() => undefined);
    return {
      ok: false,
      error: typeof said === "string" && said.trim() ? said.trim() : null,
    };
  } catch {
    return { ok: false, error: null };
  }
}
