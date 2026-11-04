import type {
  BrowserApiState,
  BrowserOpenResponse,
  RealBrowserOpenResponse,
} from "@openbot/shared/openbot-browser";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import { queryClient } from "@/query-client";
import { TEACH_A_BOT } from "./browser-nav-item";
import { ScreenBrowser } from "./browser-screen";
import { TeachSteps } from "./teach-steps";

const TITLE = TEACH_A_BOT;
const DESCRIPTION =
  "Show your Bots how to do a task. Name it, press Start recording, and do it in the browser that opens.";

/**
 * The Browser page: the signed-in person's own browser, opened when they arrive, and Record and Stop for it.
 *
 * Its state is read every second while the page is open, as the computer's control state is, because what changes
 * (the tabs, a recording's actions) changes in the browser rather than here.
 */
export function BrowserPage() {
  const state = useQuery(browserStateQueryOptions({ poll: true }));
  if (state.isPending) return null;
  // Branched on the data rather than the error: a poll that fails after the page has opened keeps the browser on
  // screen, where tearing it down would open it all over again.
  if (state.data === undefined) {
    return (
      <PageShell title={TITLE}>
        <p className="mt-6 text-destructive text-sm" role="alert">
          Couldn't load your browser. Reload the page.
        </p>
      </PageShell>
    );
  }
  if (!state.data.available) {
    // Why, where the server can say: its Bots share one computer, say, which is no place for a browser of the person's.
    return (
      <PageShell title={TITLE}>
        <PageEmpty>
          {state.data.note ??
            "OpenBot isn't set up to run a browser for you. Ask an admin."}
        </PageEmpty>
      </PageShell>
    );
  }
  return <OpenedBrowser state={state.data} />;
}

/**
 * Shows the browser the way the server says it shows. A window on the person's desktop (`native`) opens when they press
 * Open, so arriving here opens nothing. A browser in the page is the page itself, so it opens once on arrival.
 */
function OpenedBrowser({ state }: { state: BrowserApiState }) {
  const native = state.shows === "native";
  const open = useMutation(openBrowserMutationOptions(queryClient));
  // Its own mutation, so bringing the browser forward never blanks the page while it is asked.
  const reopen = useMutation(openBrowserMutationOptions(queryClient));
  // Once per arrival. A ref, not the mutation's state, because a development build runs this effect twice.
  const asked = useRef(false);
  const { mutate } = open;
  useEffect(() => {
    if (native || asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate, native]);

  // A window on the person's desktop opens with Start recording, from the page itself.
  if (native) return <NativeBrowser state={state} />;
  const opened: BrowserOpenResponse | RealBrowserOpenResponse | undefined =
    reopen.data ?? open.data;
  if (!opened) {
    // A browser that is there and not answering says so while it is asked to open, rather than leaving the page empty.
    const said = state.problem ?? open.error?.message;
    return (
      <PageShell title={TITLE} description={DESCRIPTION}>
        {/* While it opens, nothing: OpenBot draws no loading placeholder (openbot-data-access), and what arrives is the
            browser itself. */}
        {said ? (
          <div className="mt-6 flex flex-col items-start gap-3">
            <p className="text-destructive text-sm" role="alert">
              {said}
            </p>
            {open.error ? (
              <Button onClick={() => open.mutate()} size="sm" variant="outline">
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
      </PageShell>
    );
  }
  // The person's own everyday browser (OpenBot Desktop) has no screen here: it is a window on their desktop.
  if ("window" in opened && opened.window === "screen") {
    return (
      <ScreenBrowser
        computerId={opened.computerId}
        state={state}
        reopen={() => reopen.mutate()}
        reopening={reopen.isPending}
      />
    );
  }
  // Only an older server says nothing of where its browser shows, and it may answer with a window after all.
  return <NativeBrowser state={state} />;
}

/**
 * THE PERSON'S BROWSER AS A WINDOW ON THEIR DESKTOP (OpenBot Desktop): their own Chrome, or Edge, in a profile of its
 * own. The page walks the person through it in three steps (`TeachSteps`): what it does, naming the task, and opening
 * the browser already recording. They stop in the browser, from the Recorder's mark at the top of each page, which asks
 * whether to save the recording, or here with Stop, which saves it.
 */
function NativeBrowser({ state }: { state: BrowserApiState }) {
  return (
    <PageShell title={TITLE}>
      <TeachSteps state={state} />
    </PageShell>
  );
}
