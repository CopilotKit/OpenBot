import type {
  BrowserApiState,
  BrowserTab,
} from "@openbot/shared/openbot-browser";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBrowser,
  IconPlus,
  IconReload,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  LiveScreen,
  type LiveScreenHandle,
} from "@/components/computer/live-screen";
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
  navigateBrowserMutationOptions,
} from "@/lib/browser/mutations";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
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
 * A tab's name as the strip shows it: its title, else its host, else what Chrome calls an empty tab.
 *
 * A page with no title of its own is titled with its address by the browser, which is what the computer reports: an
 * empty tab comes back as `about:blank`, titled `about:blank`. So a title that is only the tab's address is no title.
 */
export function tabName(tab: BrowserTab): string {
  const title = tab.title.trim();
  if (title && title !== tab.url) return title;
  if (!tab.url || tab.url === "about:blank") return "New tab";
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

/** The error of the request asked last among those that failed, or null when none did. */
function latest(asked: { error: Error | null; at: number }[]): Error | null {
  let last: { error: Error; at: number } | null = null;
  for (const { error, at } of asked)
    if (error && (!last || at >= last.at)) last = { error, at };
  return last?.error ?? null;
}

/** What the address bar shows for a tab: nothing for an empty one, so the placeholder says what to do. */
function shownAddress(tab: BrowserTab | undefined): string {
  return !tab || tab.url === "about:blank" ? "" : tab.url;
}

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
  const active = state.tabs.find((tab) => tab.active);
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
        onNew={() => tabs.mutate({ action: "new" })}
      />
      {/* The selected tab's panel: what the tab strip's tabs control, named by the tab that shows. */}
      <div
        aria-label={active ? undefined : "Browser"}
        aria-labelledby={active ? tabId(ids, active.id) : undefined}
        className="flex min-h-0 flex-1 flex-col"
        id={panelId(ids)}
        role="tabpanel"
      >
        <AddressBar
          // A new tab, or switching to one, starts the bar again from that tab's own address.
          key={active?.id ?? "none"}
          address={shownAddress(active)}
          disabled={!state.open || !active}
          onGo={(url) => {
            navigate.mutate({ url });
            // Away to the page, as Chrome's address bar does: the next keys are for the page that opens.
            screen.current?.focus();
          }}
          onMove={(action) => navigate.mutate({ action })}
        />
        <Screen
          computerId={computerId}
          notAnswering={state.problem}
          open={state.open}
          reopen={reopen}
          reopening={reopening}
          screen={screen}
        />
      </div>
    </div>
  );
}

const tabId = (ids: string, id: string) => `${ids}-tab-${id}`;
const panelId = (ids: string) => `${ids}-panel`;

/**
 * The browser's tabs, as WAI-ARIA tabs (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): one stop in the Tab order,
 * the tab that shows, and the arrow keys, Home and End to move between them. Moving does not switch the browser's tab,
 * since that is a request to the computer: Enter or Space does, as a click does (the pattern's manual activation, for
 * tabs whose panel takes a moment to show). Delete closes the focused tab, the pattern's key for a tab that can be
 * closed. Every tab controls the one panel below, the address bar and the screen of the tab that shows.
 *
 * Each tab's close button is the mouse's way to the same Delete, outside the accessibility tree: a tab list owns tabs
 * alone, and a button inside a tab is lost to it.
 *
 * Delete on the tab that shows puts the focus on the tab the browser shows next, which only the browser knows: its
 * computer brings forward the person's newest tab (agent-computer's profiles.ts, `retarget`), not the neighbour the
 * pattern suggests. Focus went to the neighbour while another tab showed, so Enter there switched the browser again.
 * Delete on another tab leaves the one that shows as it is, and the focus moves to a neighbour, as the pattern has it.
 */
function TabStrip({
  ids,
  tabs,
  disabled,
  onActivate,
  onClose,
  onNew,
}: {
  ids: string;
  tabs: BrowserTab[];
  disabled: boolean;
  onActivate: (tabId: string) => void;
  /** `closed` hears the browser's answer: its tabs after the close. */
  onClose: (
    tabId: string,
    closed?: (answer: { tabs: BrowserTab[] }) => void,
  ) => void;
  onNew: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selected = tabs.find((tab) => tab.active) ?? tabs[0];
  const focusAt = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (tab) buttons.current.get(tab.id)?.focus();
  };
  /** The tab the focus goes to once it is drawn: the one the browser shows after a close, which can be a new one. */
  const focusNext = useRef<string | null>(null);
  const focusWhenDrawn = () => {
    const button = focusNext.current
      ? buttons.current.get(focusNext.current)
      : undefined;
    if (!button) return;
    focusNext.current = null;
    button.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new set of tabs may draw the one waiting for the focus.
  useEffect(focusWhenDrawn, [tabs]);
  const onKeyDown = (event: KeyboardEvent, index: number, tab: BrowserTab) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => focusAt(index + 1),
      ArrowLeft: () => focusAt(index - 1),
      Home: () => focusAt(0),
      End: () => focusAt(tabs.length - 1),
      Delete: () => {
        if (disabled) return;
        if (tab.active) {
          // The browser says which tab it shows now, and the focus goes there.
          onClose(tab.id, (answer) => {
            focusNext.current =
              answer.tabs.find((each) => each.active)?.id ?? null;
            focusWhenDrawn();
          });
          return;
        }
        // Focus goes to the tab after it, or the one before when it was the last, before it goes.
        if (tabs.length > 1)
          focusAt(index === tabs.length - 1 ? index - 1 : index + 1);
        onClose(tab.id);
      },
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  };
  return (
    <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <div
        aria-label="Tabs"
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
        role="tablist"
      >
        {tabs.map((tab, index) => {
          const name = tabName(tab);
          return (
            <div
              key={tab.id}
              className={cn(
                "flex min-w-0 max-w-56 shrink-0 items-center rounded-lg",
                tab.active ? "bg-secondary" : "hover:bg-muted",
              )}
            >
              <button
                aria-controls={panelId(ids)}
                aria-keyshortcuts="Delete"
                aria-selected={tab.active}
                className="min-w-0 flex-1 truncate rounded-lg py-1 pr-1 pl-2.5 text-left text-[0.8rem] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                disabled={disabled}
                id={tabId(ids, tab.id)}
                onClick={() => {
                  if (!tab.active) onActivate(tab.id);
                }}
                onKeyDown={(event) => onKeyDown(event, index, tab)}
                ref={(element) => {
                  if (element) buttons.current.set(tab.id, element);
                  else buttons.current.delete(tab.id);
                }}
                role="tab"
                tabIndex={tab.id === selected?.id ? 0 : -1}
                title={tab.url}
                type="button"
              >
                {name}
              </button>
              <Button
                aria-hidden="true"
                className="mr-0.5"
                disabled={disabled}
                onClick={() => onClose(tab.id)}
                size="icon-xs"
                tabIndex={-1}
                title={`Close ${name}`}
                variant="ghost"
              >
                <IconX />
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        aria-label="New tab"
        disabled={disabled}
        onClick={onNew}
        size="icon-sm"
        variant="ghost"
      >
        <IconPlus />
      </Button>
    </div>
  );
}

/**
 * Back, forward, reload and the address. What the person types stays theirs until they press Enter or Escape, so the
 * page's once-a-second refresh of the tab never overwrites an address half typed.
 */
function AddressBar({
  address,
  disabled,
  onGo,
  onMove,
}: {
  address: string;
  disabled: boolean;
  onGo: (url: string) => void;
  onMove: (action: "back" | "forward" | "reload") => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      aria-label="Address bar"
      className="flex items-center gap-1 border-b border-border px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const url = addressFrom(draft ?? address);
        if (!url) return;
        setDraft(null);
        // Away from the bar, as Chrome's address bar goes: the next click in it selects the address to type over.
        input.current?.blur();
        onGo(url);
      }}
    >
      <Button
        aria-label="Back"
        disabled={disabled}
        onClick={() => onMove("back")}
        size="icon-sm"
        variant="ghost"
      >
        <IconArrowLeft />
      </Button>
      <Button
        aria-label="Forward"
        disabled={disabled}
        onClick={() => onMove("forward")}
        size="icon-sm"
        variant="ghost"
      >
        <IconArrowRight />
      </Button>
      <Button
        aria-label="Reload"
        disabled={disabled}
        onClick={() => onMove("reload")}
        size="icon-sm"
        variant="ghost"
      >
        <IconReload />
      </Button>
      <InputGroup className="ml-1 h-8 flex-1 bg-background text-sm">
        <InputGroupInput
          aria-label="Address"
          ref={input}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
          }}
          placeholder="Search or type an address"
          spellCheck={false}
          value={draft ?? address}
        />
        <InputGroupAddon>
          <IconWorld />
        </InputGroupAddon>
      </InputGroup>
    </form>
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
