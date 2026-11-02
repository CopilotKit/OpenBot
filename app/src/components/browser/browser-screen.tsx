import type { BrowserApiState } from "@openbot/shared/openbot-browser";
import { IconBrowser } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { type RefObject, useId, useRef, useState } from "react";
import {
  LiveScreen,
  type LiveScreenHandle,
} from "@/components/computer/live-screen";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
  browserTabsMutationOptions,
  clearBrowserMutationOptions,
  navigateBrowserMutationOptions,
} from "@/lib/browser/mutations";
import { queryClient } from "@/query-client";
import {
  AddressBar,
  ClearBrowserDialog,
  latest,
  shownAddress,
  TabPanel,
  TabStrip,
  useClearBrowserData,
  useOpenedTab,
} from "./browser-bar";
import { NarrationNotice, NarrationSwitch } from "./narration";
import { NarrationChoiceDialog, useNarrationChoice } from "./narration-choice";
import {
  narrationLanguage,
  RecordingBar,
  StoppedNotice,
  useRecording,
} from "./recording";
import { useNarration } from "./use-narration";

/** The shape of the computer's browser viewport, kept for the screen before its first frame says otherwise. */
const SCREEN_ASPECT_RATIO = 1280 / 800;

/**
 * THE PERSON'S BROWSER, SHOWN IN THE PAGE (hosted OpenBot). A cloud browser has no window of its own, so the page is
 * the window: a bar with the recording controls, the tabs, the address bar with back, forward and reload, and the live
 * screen, which the person already drives (it is their browser, so there is no wheel to take).
 *
 * NOT A PageShell, ON PURPOSE. A browser is a canvas, not a column of settings: in the 720px prose column a 1280px
 * page is drawn at little more than half size, too small to read or click. It fills the pane instead, as a
 * conversation does, with the conversation page's own header bar above it.
 */
export function ScreenBrowser({
  computerId,
  state,
  reopen,
  reopening,
}: {
  computerId: string;
  state: BrowserApiState;
  reopen: () => void;
  reopening: boolean;
}) {
  const language = narrationLanguage();
  const choice = useNarrationChoice();
  const narration = useNarration({
    listening: state.recorder?.phase === "recording",
    language,
    chosen: choice.narration === "on",
  });
  const recording = useRecording(state, choice, {
    beforeStop: narration.finish,
    // A yes on the narration question is the person's click: narration turns on with it, asking the browser for its
    // speech recognition on their computer while the click still counts.
    answered: (narrate) => {
      if (narrate) narration.setOn(true);
    },
  });
  const tabs = useMutation(browserTabsMutationOptions(queryClient));
  const navigate = useMutation(navigateBrowserMutationOptions(queryClient));
  const clear = useMutation(clearBrowserMutationOptions(queryClient));
  const clearing = useClearBrowserData(clear);
  const active = state.tabs.find((tab) => tab.active);
  const newTab = useOpenedTab(active?.id);
  const ids = useId();
  const screen = useRef<LiveScreenHandle>(null);
  // The refusal of whatever the person asked last: an older one (a tab that would not close) never hides a newer one
  // (Record refused) in the one line there is for them.
  const failure = latest([
    { error: tabs.error, at: tabs.submittedAt },
    { error: navigate.error, at: navigate.submittedAt },
    { error: recording.error, at: recording.failedAt },
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 flex-row flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <SidebarToggle />
          <IconBrowser
            aria-hidden="true"
            className="size-4.5 shrink-0 text-muted-foreground"
          />
          <h1 className="truncate text-sm tracking-tight">Browser</h1>
        </div>
        <RecordingBar recording={recording}>
          <NarrationSwitch
            narration={narration}
            recording={recording.phase !== "idle"}
            onChange={(on) => {
              narration.setOn(on);
              choice.choose(on);
            }}
          />
        </RecordingBar>
      </div>
      {/* On OpenBot Desktop, why this is a browser in the page rather than the person's own Chrome or Edge. */}
      {state.note ? (
        <p className="border-b border-border px-3 py-2 text-muted-foreground text-sm">
          {state.note}
        </p>
      ) : null}
      <NarrationNotice narration={narration} language={language} />
      <NarrationChoiceDialog {...recording.question} />
      <ClearBrowserDialog
        clear={clear}
        open={clearing.asking}
        onOpenChange={clearing.setAsking}
      />
      {recording.stopped ? <StoppedNotice stopped={recording.stopped} /> : null}
      {failure ? (
        <p
          className="border-b border-border px-3 py-2 text-destructive text-sm"
          role="alert"
        >
          {failure.message}
        </p>
      ) : null}
      <TabStrip
        ids={ids}
        tabs={state.tabs}
        disabled={!state.open}
        onActivate={(tabId) => tabs.mutate({ action: "activate", tabId })}
        onClose={(tabId, closed) =>
          tabs.mutate(
            { action: "close", tabId },
            closed ? { onSuccess: closed } : undefined,
          )
        }
        onNew={() =>
          tabs.mutate({ action: "new" }, { onSuccess: newTab.opened })
        }
      />
      <TabPanel
        active={active}
        className="flex min-h-0 flex-1 flex-col"
        ids={ids}
      >
        <AddressBar
          // A new tab, or switching to one, starts the bar again from that tab's own address.
          key={active?.id ?? "none"}
          address={shownAddress(active)}
          disabled={!state.open || !active}
          focus={newTab.focus}
          onFocused={newTab.onFocused}
          onGo={(url) => {
            navigate.mutate({ url });
            // Away to the page, as Chrome's address bar does: the next keys are for the page that opens.
            screen.current?.focus();
          }}
          onMove={(action) => navigate.mutate({ action })}
          // Open or closed, or not answering (often why it is cleared), its data is there to wipe. A recording that is
          // starting or stopping is let finish first; one that is running is ended by the clear itself.
          clear={{
            disabled: recording.starting || recording.stopping,
            ask: clearing.ask,
          }}
        />
        <Screen
          computerId={computerId}
          notAnswering={state.problem}
          open={state.open}
          reopen={reopen}
          reopening={reopening}
          screen={screen}
        />
      </TabPanel>
    </div>
  );
}

/**
 * The live screen, as large as the pane allows at the browser's own shape. Sized against the pane with container
 * units rather than a measured width, so it fits both ways as the window or the sidebar changes.
 */
function Screen({
  computerId,
  notAnswering,
  open,
  reopen,
  reopening,
  screen,
}: {
  computerId: string;
  /** Why there is nothing to show: the browser is there and not answering (`BrowserApiState.problem`). */
  notAnswering?: string;
  open: boolean;
  reopen: () => void;
  reopening: boolean;
  screen: RefObject<LiveScreenHandle | null>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  return (
    <div
      className="flex min-h-0 flex-1 items-start justify-center bg-muted/40 p-3"
      style={{ containerType: "size" }}
    >
      <div
        className="overflow-hidden rounded-lg border border-border bg-background"
        style={{
          width: `min(100cqw, calc(100cqh * ${SCREEN_ASPECT_RATIO}))`,
        }}
      >
        <div
          className="relative w-full"
          style={{ aspectRatio: SCREEN_ASPECT_RATIO }}
        >
          {open ? (
            <LiveScreen
              computerId={computerId}
              driving
              label="Your browser. Click it to type into it, and press Escape to leave it."
              onProblem={setProblem}
              ref={screen}
              retryKey={retryKey}
            />
          ) : null}
          {notAnswering ? (
            // Not "closed", and nothing to press: opening it again would wait on the same browser. It comes back here
            // by itself once it answers, since the page asks every second.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm">
              <span className="text-destructive" role="alert">
                {notAnswering}
              </span>
            </div>
          ) : !open ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground text-sm">
              <span>Your browser is closed.</span>
              <Button disabled={reopening} onClick={reopen} size="sm">
                {reopening ? "Opening…" : "Open it again"}
              </Button>
            </div>
          ) : problem ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/85 p-4 text-center text-muted-foreground text-sm">
              <span>{problem}</span>
              <Button
                onClick={() => {
                  setProblem(null);
                  setRetryKey((value) => value + 1);
                }}
                size="sm"
                variant="outline"
              >
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
