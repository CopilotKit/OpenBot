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
import { useRef, useState } from "react";
import { LiveScreen } from "@/components/computer/live-screen";
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
  const narration = useNarration({
    listening: state.recorder?.phase === "recording",
    language,
  });
  const recording = useRecording(state, narration.finish);
  const tabs = useMutation(browserTabsMutationOptions(queryClient));
  const navigate = useMutation(navigateBrowserMutationOptions(queryClient));
  const active = state.tabs.find((tab) => tab.active);
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
          <NarrationSwitch narration={narration} />
        </RecordingBar>
      </div>
      <NarrationNotice narration={narration} language={language} />
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
        tabs={state.tabs}
        disabled={!state.open}
        onActivate={(tabId) => tabs.mutate({ action: "activate", tabId })}
        onClose={(tabId) => tabs.mutate({ action: "close", tabId })}
        onNew={() => tabs.mutate({ action: "new" })}
      />
      <AddressBar
        // A new tab, or switching to one, starts the bar again from that tab's own address.
        key={active?.id ?? "none"}
        address={shownAddress(active)}
        disabled={!state.open || !active}
        onGo={(url) => navigate.mutate({ url })}
        onMove={(action) => navigate.mutate({ action })}
      />
      <Screen
        computerId={computerId}
        open={state.open}
        reopen={reopen}
        reopening={reopening}
      />
    </div>
  );
}

function TabStrip({
  tabs,
  disabled,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: BrowserTab[];
  disabled: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <div
        aria-label="Tabs"
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
        role="tablist"
      >
        {tabs.map((tab) => {
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
                aria-selected={tab.active}
                className="min-w-0 flex-1 truncate py-1 pr-1 pl-2.5 text-left text-[0.8rem]"
                disabled={disabled}
                onClick={() => {
                  if (!tab.active) onActivate(tab.id);
                }}
                role="tab"
                title={tab.url}
                type="button"
              >
                {name}
              </button>
              <Button
                aria-label={`Close ${name}`}
                className="mr-0.5"
                disabled={disabled}
                onClick={() => onClose(tab.id)}
                size="icon-xs"
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
        // Away to the page, as Chrome's address bar does: the next click in it selects the address to type over.
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
  open,
  reopen,
  reopening,
}: {
  computerId: string;
  open: boolean;
  reopen: () => void;
  reopening: boolean;
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
              label="Your browser. Click and type here."
              onProblem={setProblem}
              retryKey={retryKey}
            />
          ) : null}
          {!open ? (
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
