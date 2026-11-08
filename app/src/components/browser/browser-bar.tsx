import type { BrowserTab } from "@openbot/shared/openbot-browser";
import {
  IconArrowLeft,
  IconArrowRight,
  IconEraser,
  IconLock,
  IconPlus,
  IconReload,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { toast } from "@/components/ui/toast";
import { addressFrom } from "@/lib/browser/address";
import { cn } from "@/lib/utils";

/*
 * THE BAR ABOVE A BROWSER SHOWN IN THE PAGE: its tabs, then back, forward, reload, Clear browser data and the address.
 * One component for both browsers a person works in through OpenBot, their own (the Browser page, hosted) and a Bot's
 * (the Bot's screen), so the two never drift into two different browsers.
 */

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

/** What the address bar shows for a tab: nothing for an empty one, so the placeholder says what to do. */
export function shownAddress(tab: BrowserTab | undefined): string {
  return !tab || tab.url === "about:blank" ? "" : tab.url;
}

/** The error of the request asked last among those that failed, or null when none did. */
export function latest(
  asked: { error: Error | null; at: number }[],
): Error | null {
  let last: { error: Error; at: number } | null = null;
  for (const { error, at } of asked)
    if (error && (!last || at >= last.at)) last = { error, at };
  return last?.error ?? null;
}

const tabId = (ids: string, id: string) => `${ids}-tab-${id}`;
const panelId = (ids: string) => `${ids}-panel`;

/**
 * The browser's tabs, as WAI-ARIA tabs (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): one stop in the Tab order,
 * the tab that shows, and the arrow keys, Home and End to move between them. Moving does not switch the browser's tab,
 * since that is a request to the computer: Enter or Space does, as a click does (the pattern's manual activation, for
 * tabs whose panel takes a moment to show). Delete closes the focused tab, the pattern's key for a tab that can be
 * closed. Every tab controls the one panel below (`TabPanel`, given the same `ids`), the address bar and the screen of
 * the tab that shows.
 *
 * Each tab's close button is the mouse's way to the same Delete, outside the accessibility tree: a tab list owns tabs
 * alone, and a button inside a tab is lost to it.
 *
 * Delete on the tab that shows puts the focus on the tab the browser shows next, which only the browser knows: its
 * computer brings forward the newest tab (agent-computer's profiles.ts, `retarget`, for the person's browser and a
 * Bot's alike), not the neighbour the pattern suggests. Focus went to the neighbour while another tab showed, so Enter
 * there switched the browser again. Delete on another tab leaves the one that shows as it is, and the focus moves to a
 * neighbour, as the pattern has it.
 *
 * `disabled` is a browser nobody here may work: closed, or a Bot's while the Bot holds the wheel. Its tabs still say
 * which one shows.
 */
export function TabStrip({
  ids,
  tabs,
  disabled,
  onActivate,
  onClose,
  onNew,
  start,
}: {
  /** From `useId`, shared with the `TabPanel` the tabs control. */
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
  /** Drawn at the start of the strip, before the tabs: the page's sidebar toggle, where the browser fills the page. */
  start?: ReactNode;
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
  /*
   * Drawn as a desktop browser's tabs: the strip is the window's frame colour, and the tab that shows is the page's own
   * colour, open at the bottom into the toolbar beneath it, so the two read as one sheet the tab sits on. The others are
   * quieter until hovered.
   */
  return (
    <div className="flex min-w-0 items-end gap-1 border-border border-b bg-sidebar px-2 pt-1.5">
      {start ? (
        <div className="flex shrink-0 items-center self-center pb-1.5">
          {start}
        </div>
      ) : null}
      <div
        aria-label="Tabs"
        className="-mb-px flex min-w-0 items-end gap-0.5 overflow-x-auto"
        role="tablist"
      >
        {tabs.map((tab, index) => {
          const name = tabName(tab);
          return (
            <div
              key={tab.id}
              className={cn(
                "group/tab flex h-8 w-52 min-w-24 shrink items-center gap-1 rounded-t-[10px] border border-transparent border-b-0 pl-2.5 transition-colors",
                tab.active
                  ? "border-border bg-background text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              <IconWorld
                aria-hidden="true"
                className="size-3.5 shrink-0 opacity-60"
              />
              <button
                aria-controls={panelId(ids)}
                aria-keyshortcuts="Delete"
                aria-selected={tab.active}
                className="min-w-0 flex-1 truncate rounded-md py-1 pr-1 text-left text-[0.8rem] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
                className={cn(
                  "mr-1 rounded-full",
                  // Shown on the tab that shows and the one under the pointer, as a desktop browser does.
                  !tab.active &&
                    "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                )}
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
        className="mb-1 self-center"
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
 * The selected tab's panel: what the `TabStrip` with the same `ids` controls, named by the tab that shows. It holds the
 * address bar and the screen. `tabs` false is a browser with no strip drawn yet: then it is only a box.
 */
export function TabPanel({
  ids,
  active,
  tabs = true,
  className,
  children,
}: {
  ids: string;
  active: BrowserTab | undefined;
  tabs?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // The same element either way, so what is inside it keeps its place when the strip arrives.
  if (!tabs) return <div className={className}>{children}</div>;
  return (
    <div
      aria-label={active ? undefined : "Browser"}
      aria-labelledby={active ? tabId(ids, active.id) : undefined}
      className={className}
      id={panelId(ids)}
      role="tabpanel"
    >
      {children}
    </div>
  );
}

/**
 * Back, forward, reload and the address. What the person types stays theirs until they press Enter or Escape, so the
 * page's once-a-second refresh of the tab never overwrites an address half typed.
 *
 * `readOnly` is a browser someone else is driving (a Bot's, while the Bot holds the wheel): the address stays legible,
 * because where the Bot is is the point of showing it, and nothing in the bar acts. `disabled` is a browser with
 * nothing to show (closed, or no tab), drawn faded.
 *
 * `focus` takes the focus into the address, as Chrome does for a tab the person has just opened, so they can type
 * where to go at once; `onFocused` says it has, so it happens once rather than every time they come back to the tab.
 *
 * `clear` draws Clear browser data beside reload, which asks first (`ClearBrowserDialog`). Only the button is here: the
 * bar is drawn again for each tab and each change of the wheel, and the question must not close with it.
 */
export function AddressBar({
  address,
  disabled,
  readOnly = false,
  focus = false,
  onFocused,
  onGo,
  onMove,
  clear,
  className,
}: {
  address: string;
  disabled: boolean;
  readOnly?: boolean;
  focus?: boolean;
  onFocused?: () => void;
  onGo: (url: string) => void;
  onMove: (action: "back" | "forward" | "reload") => void;
  clear?: { disabled: boolean; ask: () => void };
  /** Where the bar shares its row with other controls, the row draws the border instead. */
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const still = disabled || readOnly;
  useEffect(() => {
    if (!focus || still) return;
    input.current?.focus();
    onFocused?.();
  }, [focus, still, onFocused]);
  return (
    <form
      aria-label="Address bar"
      className={cn(
        "flex items-center gap-0.5 border-border border-b bg-background px-2 py-1.5",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (still) return;
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
        disabled={still}
        onClick={() => onMove("back")}
        size="icon-sm"
        variant="ghost"
      >
        <IconArrowLeft />
      </Button>
      <Button
        aria-label="Forward"
        disabled={still}
        onClick={() => onMove("forward")}
        size="icon-sm"
        variant="ghost"
      >
        <IconArrowRight />
      </Button>
      <Button
        aria-label="Reload"
        disabled={still}
        onClick={() => onMove("reload")}
        size="icon-sm"
        variant="ghost"
      >
        <IconReload />
      </Button>
      {clear ? (
        <Button
          aria-label="Clear browser data"
          disabled={clear.disabled}
          onClick={clear.ask}
          size="icon-sm"
          title="Clear browser data"
          variant="ghost"
        >
          <IconEraser />
        </Button>
      ) : null}
      {/* A pill in the window's frame colour, as a desktop browser's address bar is, lit like a field while typed in. */}
      <InputGroup className="ml-1.5 h-8 min-w-0 flex-1 rounded-full border-transparent bg-muted/70 text-sm shadow-none transition-colors has-[[data-slot=input-group-control]:focus-visible]:bg-background dark:bg-input/40">
        <InputGroupInput
          aria-label="Address"
          ref={input}
          disabled={disabled}
          readOnly={readOnly}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
          }}
          placeholder="Search or type an address"
          spellCheck={false}
          value={draft ?? address}
        />
        <InputGroupAddon className="pl-3">
          {address.startsWith("https://") ? (
            <IconLock aria-hidden="true" />
          ) : (
            <IconWorld />
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

/** The browser's own clear (the person's browser's or a Bot's), as `useMutation` gives it. */
type ClearMutation = Pick<
  UseMutationResult<unknown, Error, void>,
  "mutate" | "isPending" | "error" | "reset"
>;

/**
 * CLEAR BROWSER DATA: one button beside reload (`AddressBar`'s `clear`), and a confirmation short enough to be read,
 * because the browser's data can go wrong and wiping it is the way back (`shared/bot-browser.ts`, CLEARING A BROWSER).
 * Everything it is signed in to goes with it, which is the one thing the confirmation says. Cancel does nothing; Clear
 * wipes it, the browser starts again fresh, and a toast says so.
 *
 * This is the question being asked, kept by whoever draws the bar rather than by the bar, and `ask` for the button.
 */
export function useClearBrowserData(clear: ClearMutation) {
  const [asking, setAsking] = useState(false);
  return {
    asking,
    setAsking,
    ask: () => {
      clear.reset();
      setAsking(true);
    },
  };
}

/**
 * The confirmation Clear browser data asks (`useClearBrowserData`). A refusal is said in it, where Clear was pressed.
 * `stacked` is a confirmation opened over another dialog (the Bot's screen), which then gets its own backdrop: Base UI
 * draws none for a nested dialog unless asked.
 */
export function ClearBrowserDialog({
  clear,
  open,
  onOpenChange,
  stacked = false,
}: {
  clear: ClearMutation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stacked?: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        {...(stacked
          ? {
              overlayClassName:
                "bg-black/20 supports-backdrop-filter:backdrop-blur-sm",
            }
          : {})}
      >
        <DialogHeader>
          <DialogTitle>Clear this browser?</DialogTitle>
          <DialogDescription>
            Cookies, saved passwords and history are wiped. You'll have to sign
            in everywhere again.
          </DialogDescription>
        </DialogHeader>
        {clear.error ? (
          <DialogBody className="mt-4">
            <p className="text-destructive text-sm" role="alert">
              {clear.error.message}
            </p>
          </DialogBody>
        ) : null}
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={clear.isPending}
            onClick={() =>
              clear.mutate(undefined, {
                onSuccess: () => {
                  onOpenChange(false);
                  toast.add({ title: "Browser cleared", type: "success" });
                },
              })
            }
            size="sm"
            variant="destructive"
          >
            {clear.isPending ? "Clearing…" : "Clear"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The tab the person has just opened with New tab, until its address bar has taken the focus: `opened` to call with the
 * tabs request's answer, and the props that hand the focus to `AddressBar` when that tab is the one showing.
 */
export function useOpenedTab(activeId: string | undefined) {
  const [opened, setOpened] = useState<string | null>(null);
  const focused = useCallback(() => setOpened(null), []);
  return {
    /** Takes the answer to New tab, which shows the new tab in front. */
    opened: (state: { tabs: BrowserTab[] }) =>
      setOpened(state.tabs.find((tab) => tab.active)?.id ?? null),
    focus: opened !== null && opened === activeId,
    onFocused: focused,
  };
}
