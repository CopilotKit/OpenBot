import type {
  BrowserApiState,
  BrowserOpenResponse,
  RealBrowserOpenResponse,
} from "@openbot/shared/openbot-browser";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import { recorderKeys } from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";
import { TEACH_A_BOT } from "./browser-nav-item";
import { OpeningBrowser, ScreenBrowser } from "./browser-screen";
import { TeachSteps } from "./teach-steps";
import { recordingOnItsWay, YourRecordings } from "./your-recordings";

const TITLE = TEACH_A_BOT;
const DESCRIPTION =
  "Show your Bots how to do a task. Press Record, name the task, and do it once in the browser.";

/**
 * The way from what was taught to what it became: the skills a Bot learned from recordings are in Settings, Learning,
 * with automatic learning and sharing. A link there, so this page stays the place to teach and the settings stay there.
 */
function LearnedLink() {
  return (
    <Link
      className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
      to="/settings/learning"
    >
      See what your Bots learned
    </Link>
  );
}

/**
 * What Teach a Bot is for, above the browser it is done in: the page's title and the whole of how, in one sentence.
 * The page's own title, as every page has one; the browser below it is the tool, not the page.
 */
function TeachHeading() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="font-semibold text-2xl tracking-tight">{TITLE}</h1>
      <p className="text-pretty text-muted-foreground text-sm">{DESCRIPTION}</p>
    </header>
  );
}

/**
 * The Browser page: the signed-in person's own browser, opened when they arrive, and Record and Stop for it.
 *
 * Its state is read every second while the page is open, as the computer's control state is, because what changes
 * (the tabs, a recording's actions) changes in the browser rather than here.
 */
export function BrowserPage() {
  const state = useQuery(browserStateQueryOptions({ poll: true }));
  // A recording that stops, here or in the browser, is a new row or a final state in the list beneath.
  const phase = state.data?.recorder?.phase;
  const before = useRef(phase);
  useEffect(() => {
    const was = before.current;
    before.current = phase;
    if ((was === "recording" || was === "stopping") && phase === "idle")
      queryClient.invalidateQueries({ queryKey: recorderKeys.recordings() });
  }, [phase]);
  // A stopped recording still on its way, or kept in the browser to be sent again, lands later: a new row then.
  const waiting = recordingOnItsWay(state.data?.recorder?.lastStopped);
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    const was = wasWaiting.current;
    wasWaiting.current = waiting;
    if (was && !waiting)
      queryClient.invalidateQueries({ queryKey: recorderKeys.recordings() });
  }, [waiting]);
  // Nothing while the browser's state is first read, which is quick: until it is, the page can't know whether its
  // browser opens in the page or as a window on the desktop, so any frame drawn now could be for nothing.
  if (state.isPending) return null;
  // Branched on the data rather than the error: a poll that fails after the page has opened keeps the browser on
  // screen, where tearing it down would open it all over again.
  if (state.data === undefined) {
    return (
      <PageShell title={TITLE}>
        <p className="mt-6 text-destructive text-sm" role="alert">
          Couldn't load your browser. Reload the page.
        </p>
        <YourRecordings action={<LearnedLink />} />
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
        <YourRecordings action={<LearnedLink />} />
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
  // The Recorder's "See it on Teach a Bot" link (`?recordings`) is to the list, so it opens no browser on arrival.
  const recordingsOnly = "recordings" in useSearch({ strict: false });
  const open = useMutation(openBrowserMutationOptions(queryClient));
  // Its own mutation, so bringing the browser forward never blanks the page while it is asked.
  const reopen = useMutation(openBrowserMutationOptions(queryClient));
  // Once per arrival. A ref, not the mutation's state, because a development build runs this effect twice.
  const asked = useRef(false);
  const { mutate } = open;
  useEffect(() => {
    if (native || recordingsOnly || asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate, native, recordingsOnly]);

  // A window on the person's desktop opens with Start recording, from the page itself.
  if (native) return <NativeBrowser state={state} />;
  const opened: BrowserOpenResponse | RealBrowserOpenResponse | undefined =
    reopen.data ?? open.data;
  if (!opened) {
    // A browser that is there and not answering says so while it is asked to open, rather than leaving the page empty.
    const said = state.problem ?? open.error?.message;
    if (!recordingsOnly)
      // Opening: the page as it will be, its browser saying it is opening (`OpeningBrowser`), or why it has not.
      return (
        <OpeningBrowser
          heading={<TeachHeading />}
          onRetry={open.error ? () => open.mutate() : undefined}
          problem={said}
        >
          <YourRecordings
            action={<LearnedLink />}
            variant="pane"
            waiting={recordingOnItsWay(state.recorder?.lastStopped)}
          />
        </OpeningBrowser>
      );
    // The Recorder's link to the list opens no browser on arrival: the list, and Open browser to open one.
    return (
      <PageShell title={TITLE} description={DESCRIPTION}>
        {recordingsOnly && !said ? (
          <div className="mt-6">
            <Button onClick={() => open.mutate()} size="sm" variant="outline">
              Open browser
            </Button>
          </div>
        ) : null}
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
        <YourRecordings
          action={<LearnedLink />}
          waiting={recordingOnItsWay(state.recorder?.lastStopped)}
        />
      </PageShell>
    );
  }
  // The person's own everyday browser has no screen here: it is a window on their desktop.
  if ("window" in opened && opened.window === "screen") {
    // ScreenBrowser is deliberately not a PageShell (the browser takes the pane). The page's title goes above the
    // browser and the list under it, in the one column the browser sets the width of.
    return (
      <ScreenBrowser
        computerId={opened.computerId}
        heading={<TeachHeading />}
        state={state}
        reopen={() => reopen.mutate()}
        reopening={reopen.isPending}
      >
        <YourRecordings
          action={<LearnedLink />}
          variant="pane"
          waiting={recordingOnItsWay(state.recorder?.lastStopped)}
        />
      </ScreenBrowser>
    );
  }
  // Only an older server says nothing of where its browser shows, and it may answer with a window after all.
  return <NativeBrowser state={state} />;
}

/**
 * THE PERSON'S BROWSER AS A WINDOW ON THEIR DESKTOP (a host-side computer of people's browsers, as scripts/start.sh
 * runs one): their own Chrome, or Edge, in a profile of its own. The page walks the person through it in three steps (`TeachSteps`): what it does, naming the task, and opening
 * the browser already recording. They stop in the browser, from the Recorder's mark at the top of each page, which asks
 * whether to save the recording, or here with Stop, which saves it.
 */
function NativeBrowser({ state }: { state: BrowserApiState }) {
  return (
    <PageShell title={TITLE}>
      <TeachSteps state={state} />
      <YourRecordings
        action={<LearnedLink />}
        waiting={recordingOnItsWay(state.recorder?.lastStopped)}
      />
    </PageShell>
  );
}
