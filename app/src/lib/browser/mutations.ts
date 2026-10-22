import {
  type BrowserApiState,
  type BrowserNarrationRequest,
  type BrowserNavigateRequest,
  type BrowserOpenResponse,
  type BrowserTabsRequest,
  browserApiPaths,
} from "@openbot/shared/openbot-browser";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { browserKeys } from "./queries";

function invalidateBrowser(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: browserKeys.all });
}

/**
 * Opens the person's browser, or brings it forward when it is already open: on OpenBot Desktop a window on their
 * desktop, on hosted OpenBot a browser the page shows. The answer says which, and names the computer the live screen
 * streams.
 */
export function openBrowserMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<BrowserOpenResponse> =>
      (
        await client(browserApiPaths.open, {
          method: "POST",
          fallback: "Couldn't open your browser. Try again.",
        })
      ).json(),
    onSuccess: () => invalidateBrowser(queryClient),
  });
}

/** Starts recording the tab the person is on, named for the task. `language` is the one narration is heard in. */
export function startBrowserRecordingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      title: string;
      language?: string;
    }): Promise<BrowserApiState> =>
      (
        await client(browserApiPaths.recording, {
          method: "POST",
          body: {
            action: "start",
            title: variables.title,
            ...(variables.language ? { language: variables.language } : {}),
          },
          fallback: "Couldn't start recording. Try again.",
        })
      ).json(),
    onSuccess: () => invalidateBrowser(queryClient),
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
 * One phrase the person said, with when they started and stopped saying it, handed to the Recorder in their browser.
 *
 * A plain function rather than a mutation: nothing cached changes, and it is a step inside a recording rather than a
 * write somebody pressed a button for. It answers whether the phrase arrived instead of throwing, because a phrase
 * that did not is told to the person beside the narration switch and the recording carries on.
 */
export async function sendNarration(
  phrase: BrowserNarrationRequest,
): Promise<boolean> {
  try {
    const response = await tryClient(browserApiPaths.narration, {
      method: "POST",
      body: phrase,
    });
    return response.ok;
  } catch {
    return false;
  }
}
