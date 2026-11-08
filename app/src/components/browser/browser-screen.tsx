import type { BrowserApiState } from "@openbot/shared/openbot-browser";
import { IconSearch } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import {
  LiveScreen,
  type LiveScreenHandle,
} from "@/components/computer/live-screen";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { addressFrom } from "@/lib/browser/address";
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
import { useFittedWidth } from "./fitted-window";
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
 * The narrowest the browser's column gets while the pane is wider: half the browser's own width, where its page can
 * still be read and clicked. In a shorter pane the page scrolls instead.
 */
const MIN_COLUMN_WIDTH = 640;

/**
 * THE PERSON'S BROWSER, SHOWN IN THE PAGE (hosted OpenBot). A cloud browser has no window of its own, so the page is
 * the window: a bar with the recording controls, the tabs, the address bar with back, forward and reload, and the live
 * screen, which the person already drives (it is their browser, so there is no wheel to take).
 *
 * NOT A PageShell, ON PURPOSE. A browser is a canvas, not a column of settings: in the 720px prose column a 1280px
 * page is drawn at little more than half size, too small to read or click. It takes the pane instead, in one column
 * sized with it: `heading` above the window (what the page is for) and `children` under it (the recordings), both as
 * wide as the window, so the three read as one page.
 */
export function ScreenBrowser({
  computerId,
  state,
  reopen,
  reopening,
  heading,
  children,
}: {
  computerId: string;
  state: BrowserApiState;
  reopen: () => void;
  reopening: boolean;
  /** Above the window, as wide as it. Without one the page's name is said to screen readers only. */
  heading?: ReactNode;
  /** Under the window, as wide as it. Kept short by its own cap, since its height is taken from the page's. */
  children?: ReactNode;
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
  const desk = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const width = useFittedWidth(
    desk,
    column,
    SCREEN_ASPECT_RATIO,
    true,
    MIN_COLUMN_WIDTH,
  );
  // The refusal of whatever the person asked last: an older one (a tab that would not close) never hides a newer one
  // (Record refused) in the one line there is for them.
  const failure = latest([
    { error: tabs.error, at: tabs.submittedAt },
    { error: navigate.error, at: navigate.submittedAt },
    { error: recording.error, at: recording.failedAt },
  ]);

  const go = (url: string) => {
    navigate.mutate({ url });
    // Away to the page, as Chrome's address bar does: the next keys are for the page that opens.
    screen.current?.focus();
  };

  /*
   * Laid out as a desktop browser's window, top to bottom: the tabs on the window's frame, the toolbar (back, forward,
   * reload, the address, and Record at its end, where a browser keeps its own actions), what a recording or a request
   * just did, the page, and, while a recording runs, a status bar that says whether narration is heard. Before Record
   * the narration switch in Record's popover already says whether it is on, so the bar would only repeat it.
   *
   * The column is sized to the page (`useFittedWidth`): the browser behind the window has a fixed shape, so a window that
   * took the whole pane left a blank band under the page. The heading, the window and what is under it are as wide as
   * the page lets them be while all three fit the pane, centred on it as a window on a desk, and at the top on a phone,
   * where a page starts at the top. In a pane too short for that at a usable width (`MIN_COLUMN_WIDTH`), the pane
   * scrolls; auto margins rather than centring, so a column taller than the pane starts at its top and is never cut.
   */
  return (
    <div
      ref={desk}
      className="flex min-h-0 flex-1 overflow-y-auto bg-muted/40 p-3 sm:p-5"
    >
      <NarrationChoiceDialog {...recording.question} />
      <ClearBrowserDialog
        clear={clear}
        open={clearing.asking}
        onOpenChange={clearing.setAsking}
      />
      <div
        ref={column}
        className="mx-auto flex h-fit w-full min-w-0 shrink-0 flex-col gap-4 sm:my-auto"
        style={width === undefined ? undefined : { width }}
      >
        {heading ?? <h1 className="sr-only">Browser</h1>}
        <div className="flex flex-col overflow-clip rounded-xl border bg-background shadow-sm">
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
            start={<SidebarToggle />}
          />
          <TabPanel active={active} className="flex flex-col" ids={ids}>
            <div className="flex flex-wrap items-center gap-x-2 border-border border-b bg-background pr-3">
              <AddressBar
                // A new tab, or switching to one, starts the bar again from that tab's own address.
                key={active?.id ?? "none"}
                className="min-w-64 flex-1 border-b-0"
                address={shownAddress(active)}
                disabled={!state.open || !active}
                focus={newTab.focus}
                onFocused={newTab.onFocused}
                onGo={go}
                onMove={(action) => navigate.mutate({ action })}
                // Open or closed, or not answering (often why it is cleared), its data is there to wipe. A recording that is
                // starting or stopping is let finish first; one that is running is ended by the clear itself.
                clear={{
                  disabled: recording.starting || recording.stopping,
                  ask: clearing.ask,
                }}
              />
              <div className="ml-auto py-1.5 pl-2">
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
            </div>
            {recording.stopped ? (
              <StoppedNotice stopped={recording.stopped} />
            ) : null}
            {failure ? (
              <p
                className="border-b border-border bg-background px-3 py-2 text-destructive text-sm"
                role="alert"
              >
                {failure.message}
              </p>
            ) : null}
            <Screen
              blank={!shownAddress(active)}
              computerId={computerId}
              notAnswering={state.problem}
              onGo={go}
              open={state.open}
              reopen={reopen}
              reopening={reopening}
              screen={screen}
            />
          </TabPanel>
          {recording.phase === "idle" ? null : (
            <NarrationNotice
              className="border-t border-b-0 bg-transparent px-3 py-1.5 text-xs"
              narration={narration}
              language={language}
            />
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The live screen, the full width of the window at the browser's own shape. The window is sized to fit it
 * (`useFittedWidth`), so the page fills the window with nothing blank under or beside it.
 */
function Screen({
  blank,
  computerId,
  notAnswering,
  onGo,
  open,
  reopen,
  reopening,
  screen,
}: {
  /** The tab that shows is empty: the page offers somewhere to go rather than a white rectangle. */
  blank: boolean;
  computerId: string;
  /** Why there is nothing to show: the browser is there and not answering (`BrowserApiState.problem`). */
  notAnswering?: string;
  /** Where the start page sends what is typed into it, as the address bar does. */
  onGo: (url: string) => void;
  open: boolean;
  reopen: () => void;
  reopening: boolean;
  screen: RefObject<LiveScreenHandle | null>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // The page sits flush under the toolbar, at the browser's own shape, as wide as the window.
  return (
    <div
      className="relative w-full overflow-hidden bg-background"
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
      ) : blank ? (
        <StartPage onGo={onGo} />
      ) : null}
    </div>
  );
}

/**
 * What an empty tab shows: the OpenBot orb and one field to search or go to a site, as a browser's new tab page does,
 * over the empty page the browser itself would draw white. It goes where the address bar would.
 */
function StartPage({ onGo }: { onGo: (url: string) => void }) {
  const [typed, setTyped] = useState("");
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background px-6">
      <OpenBotLogo className="size-14 drop-shadow-[0_8px_24px_rgb(120_100_220/0.35)]" />
      <form
        aria-label="Search or go to a site"
        className="w-full max-w-lg"
        onSubmit={(event) => {
          event.preventDefault();
          const url = addressFrom(typed);
          if (!url) return;
          setTyped("");
          onGo(url);
        }}
      >
        <InputGroup className="h-11 rounded-full bg-muted/50 shadow-xs dark:bg-input/40">
          <InputGroupInput
            aria-label="Search or go to a site"
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Search or type an address"
            spellCheck={false}
            value={typed}
          />
          <InputGroupAddon className="pl-4">
            <IconSearch />
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}
