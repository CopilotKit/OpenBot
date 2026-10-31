import type {
  BrowserApiState,
  BrowserOpenResponse,
  BrowserProduct,
  RealBrowserOpenResponse,
} from "@openbot/shared/openbot-browser";
import { IconBrowser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import { queryClient } from "@/query-client";
import { ScreenBrowser } from "./browser-screen";
import { NativeNarrationRow } from "./narration";
import { NarrationChoiceDialog, useNarrationChoice } from "./narration-choice";
import {
  RECORDING_DESCRIPTION,
  RecordingRow,
  StoppedRow,
  useRecording,
} from "./recording";

const TITLE = "Browser";
const DESCRIPTION =
  "Your own browser, with the OpenBot Recorder already in it. Record a task and what you do goes into your own Learning space.";

const PRODUCT_NAMES: Record<BrowserProduct, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  chromium: "Chromium",
};

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

/** Opens the browser once on arrival, then shows it the way the answer says it shows: a window, or the page. */
function OpenedBrowser({ state }: { state: BrowserApiState }) {
  const open = useMutation(openBrowserMutationOptions(queryClient));
  // Its own mutation, so bringing the browser forward never blanks the page while it is asked.
  const reopen = useMutation(openBrowserMutationOptions(queryClient));
  // Once per arrival. A ref, not the mutation's state, because a development build runs this effect twice.
  const asked = useRef(false);
  const { mutate } = open;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate]);

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
  return (
    <NativeBrowser
      product={state.browser ?? opened.browser}
      state={state}
      reopen={() => reopen.mutate()}
      reopening={reopen.isPending}
      reopenError={reopen.error}
    />
  );
}

/**
 * THE PERSON'S BROWSER AS A WINDOW ON THEIR DESKTOP (OpenBot Desktop): their own Chrome, or Edge, in a profile of its
 * own. The window is the browser, so this page says where it is, brings it to the front, and carries Record and Stop,
 * which the Recorder's toolbar button in that window also has.
 */
function NativeBrowser({
  product,
  state,
  reopen,
  reopening,
  reopenError,
}: {
  product: BrowserProduct;
  state: BrowserApiState;
  reopen: () => void;
  reopening: boolean;
  reopenError: Error | null;
}) {
  const choice = useNarrationChoice();
  const recording = useRecording(state, choice);
  return (
    <PageShell title={TITLE} description={DESCRIPTION}>
      <PageSection title="Your browser">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconBrowser />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{PRODUCT_NAMES[product]}</ItemTitle>
              <ItemDescription>
                {state.problem ??
                  (state.open
                    ? "Open in its own window on your desktop."
                    : "Closed.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={reopening}
                onClick={reopen}
                size="sm"
                variant="outline"
              >
                {state.open ? "Bring to front" : "Open"}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
        {reopenError ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {reopenError.message}
          </p>
        ) : null}
      </PageSection>
      <PageSection title="Record a task" description={RECORDING_DESCRIPTION}>
        <PageRows>
          <RecordingRow recording={recording} />
          {recording.stopped ? (
            <>
              <Separator />
              <StoppedRow stopped={recording.stopped} />
            </>
          ) : null}
          <Separator />
          <NativeNarrationRow
            voice={state.recorder?.voice}
            choice={choice}
            recording={recording.phase !== "idle"}
          />
        </PageRows>
        {recording.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {recording.error.message}
          </p>
        ) : null}
      </PageSection>
      <NarrationChoiceDialog {...recording.question} />
    </PageShell>
  );
}
