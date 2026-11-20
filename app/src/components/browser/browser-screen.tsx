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
import { LearningNextNotice, savedToLearning } from "./learning-next";
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
   */
  return (
    <>
      <NarrationChoiceDialog {...recording.question} />
      <ClearBrowserDialog
        clear={clear}
        open={clearing.asking}
        onOpenChange={clearing.setAsking}
      />
      <BrowserDesk
        heading={heading}
        window={
          <>
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
              {/* Once it is in the Learning space: what happens to it next, and the way to the skill it becomes. */}
              {recording.stopped && savedToLearning(recording.stopped) ? (
                <LearningNextNotice
                  // A new recording follows its own skill, not the last one's.
                  key={recording.stopped.recordingId}
                  stopped={recording.stopped}
                />
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
            {/* While a recording runs; before one only to say there is no microphone, so nobody narrates to nothing. */}
            {recording.phase === "idle" && !narration.noMicrophone ? null : (
              <NarrationNotice
                className="border-t border-b-0 bg-transparent px-3 py-1.5 text-xs"
                narration={narration}
                language={language}
              />
            )}
          </>
        }
      >
        {children}
      </BrowserDesk>
    </>
  );
}

/**
 * The page's one column, on a quiet backdrop: `heading` above the browser window (`window`, its tabs, toolbar and page)
 * and `children` under it, all as wide as the window.
 *
 * The column is sized to the page (`useFittedWidth`): the browser behind the window has a fixed shape, so a window that
 * took the whole pane left a blank band under the page. The heading and the window are as wide as the page lets them be
 * while they fit the pane with the least room `children` needs (its `min-h-24`: a heading and a row), and `children`
 * takes all the height left under the window, scrolling inside it. So a longer list under the browser never makes the
 * browser smaller, and its first rows are always on screen. In a pane too short for that at a usable width
 * (`MIN_COLUMN_WIDTH`), the pane scrolls.
 */
export function BrowserDesk({
  heading,
  window: browserWindow,
  children,
}: {
  heading?: ReactNode;
  window: ReactNode;
  children?: ReactNode;
}) {
  const desk = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const under = useRef<HTMLDivElement>(null);
  const width = useFittedWidth(desk, column, SCREEN_ASPECT_RATIO, {
    minWidth: MIN_COLUMN_WIDTH,
    page: frame,
    below: under,
  });
  return (
    <div
      ref={desk}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/40 p-3 sm:p-5"
    >
      {/* As tall as the desk, so what is under the window takes the height left; past it, the desk scrolls. */}
      <div
        ref={column}
        className="mx-auto flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4"
        style={width === undefined ? undefined : { width }}
      >
        {heading ?? <h1 className="sr-only">Browser</h1>}
        <div
          ref={frame}
          className="flex shrink-0 flex-col overflow-clip rounded-xl border bg-background shadow-sm"
        >
          {browserWindow}
        </div>
        {children ? (
          <div
            ref={under}
            className="flex min-h-24 flex-1 flex-col"
            data-slot="under-browser"
          >
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The page while its browser opens, which takes a few seconds: laid out as it will be, the window drawn empty and saying
 * it is opening, so the page never sits blank or half drawn. A deliberate exception to the data-access rule (no loading
 * placeholder): what arrives here is a whole browser, slow to start, and the empty pane read as broken. Nothing in the
 * frame can be pressed, so it is never mistaken for the browser itself. `problem` says why it has not opened instead,
 * with Try again where asking again can help (`onRetry`).
 */
export function OpeningBrowser({
  heading,
  problem,
  onRetry,
  children,
}: {
  heading?: ReactNode;
  problem?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <BrowserDesk
      heading={heading}
      window={
        <>
          {/* The window's frame and toolbar, empty, at the heights the browser's own have. */}
          <div className="flex min-w-0 items-end gap-1 border-border border-b bg-sidebar px-2 pt-1.5">
            <div className="flex shrink-0 items-center self-center pb-1.5">
              <SidebarToggle />
            </div>
            <div
              aria-hidden="true"
              className="h-8 w-44 rounded-t-[10px] border border-border border-b-0 bg-background"
            />
          </div>
          <div
            aria-hidden="true"
            className="flex items-center border-border border-b px-3 py-1.5"
          >
            <div className="h-8 flex-1 rounded-full bg-muted/70" />
          </div>
          <div
            className="relative w-full bg-background"
            style={{ aspectRatio: SCREEN_ASPECT_RATIO }}
          >
            {problem ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm">
                <p className="text-destructive" role="alert">
                  {problem}
                </p>
                {onRetry ? (
                  <Button onClick={onRetry} size="sm" variant="outline">
                    Try again
                  </Button>
                ) : null}
              </div>
            ) : (
              // Announced politely, but not a status role: the page's own statuses (what a recording held) are those.
              <div
                aria-live="polite"
                className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground text-sm"
              >
                <OpenBotLogo
                  aria-hidden="true"
                  className="size-12 drop-shadow-[0_8px_24px_rgb(120_100_220/0.35)] motion-safe:animate-pulse"
                />
                Opening your browser…
              </div>
            )}
          </div>
        </>
      }
    >
      {children}
    </BrowserDesk>
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
