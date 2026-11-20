import { IconMessage, IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type ComponentType,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
  channelSearchInfiniteQueryOptions,
  isChannelSearchable,
} from "@/lib/channels/queries";
import { formatHotkey, getHotkey } from "@/lib/hotkeys/hotkeys";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import { isNavigationLink, useNavigationItems } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * The command palette: one box that opens any page, Bot or conversation, from anywhere signed in.
 *
 * NAVIGATION ONLY. Every result opens a page that already exists and does nothing on its own: a
 * Bot opens its profile, never a turn, and there is nothing here to delete, approve, send, run,
 * connect or sign in to. The pages are the navigation registry's own, so a page the person can't
 * open (Admin for a member, Memory in the personal edition) is never offered.
 *
 * Conversations are the five most recent until something is typed; from two characters on they are
 * the server's search of every conversation's name and recent messages (`channelSearch`), a page at
 * a time, never a download of the whole history.
 */

/* Opened from any skin's navigation and from Cmd/Ctrl+K, so the open state lives outside them all. */
let open = false;
const listeners = new Set<() => void>();
function setOpen(next: boolean) {
  open = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens the menu. A frame's own entry calls this, after closing its mobile sidebar. */
export function openCommandMenu() {
  setOpen(true);
}

/*
 * What closes before the menu navigates. The phone sidebar is a sheet over the page: opened from
 * Cmd/Ctrl+K while it is out, the menu would otherwise leave it covering the page it just opened.
 */
const beforeNavigate = new Set<() => void>();
export function useBeforeCommandNavigate(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const run = () => ref.current();
    beforeNavigate.add(run);
    return () => {
      beforeNavigate.delete(run);
    };
  }, []);
}

/**
 * The shortcut as keycaps, for a frame's "Command palette" entry: ⌘K on a Mac, Ctrl K elsewhere.
 * Hidden from a screen reader, which reads the entry's name; the shortcut is in `aria-keyshortcuts`.
 */
export function CommandMenuKeys({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex gap-0.5", className)}>
      {formatHotkey(getHotkey("command-menu").combo).map((part) => (
        <kbd
          className="rounded border border-border bg-muted px-1 font-sans text-[10px] text-muted-foreground leading-4"
          key={part}
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}

/** What `aria-keyshortcuts` says for the entry. */
export const COMMAND_MENU_KEYS = "Meta+K Control+K";

const RECENT = 5;
const SEARCH_DEBOUNCE_MS = 250;

type Result = {
  id: string;
  group: "Pages" | "Bots" | "Conversations";
  label: string;
  detail?: string;
  icon: ComponentType<{ className?: string }>;
  go: () => void;
};

function matches(text: string, query: string) {
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/** What the sidebar calls a conversation. */
function conversationTitle(channel: ChannelSummary): string {
  return channel.summary || untitledLine(channel) || "New conversation";
}

/** The search text, settled for a moment, so a request isn't sent for every keystroke. */
function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function CommandMenu() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  // Closed when the signed-in layout goes, so it never reopens by itself later.
  useEffect(() => () => setOpen(false), []);
  useHotkey("command-menu", () => setOpen(!open));
  return (
    <Dialog onOpenChange={setOpen} open={isOpen}>
      {isOpen ? <CommandMenuBody onClose={() => setOpen(false)} /> : null}
    </Dialog>
  );
}

function CommandMenuBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** Set when a result is opened, so focus follows the new page rather than going back. */
  const navigated = useRef(false);
  const trimmed = query.trim();
  const searching = isChannelSearchable(trimmed);
  const settledText = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);

  const navigation = useNavigationItems().filter(isNavigationLink);
  const bots = useQuery(agentListQueryOptions());
  const recent = useInfiniteQuery({
    ...channelListQueryOptions(),
    enabled: !searching,
  });
  const search = useInfiniteQuery({
    ...channelSearchInfiniteQueryOptions(settledText),
    enabled: searching && isChannelSearchable(settledText),
  });
  // The debounce hasn't caught up with the box yet: the last answer is for different words.
  const searchSettling = searching && settledText !== trimmed;

  const go = (run: () => void) => () => {
    navigated.current = true;
    for (const close of beforeNavigate) close();
    onClose();
    run();
  };

  const pages: Result[] = [
    {
      id: "new-conversation",
      group: "Pages" as const,
      label: "New conversation",
      icon: IconPlus,
      go: go(() => void navigate({ to: "/channel/new" })),
    },
    ...navigation.map((item) => ({
      id: `page-${item.id}`,
      group: "Pages" as const,
      label: item.label,
      icon: item.icon,
      go: go(() => void navigate({ to: item.to })),
    })),
  ].filter((result) => !trimmed || matches(result.label, trimmed));

  const botResults: Result[] = (bots.data ?? [])
    .filter((bot) => !trimmed || matches(bot.name, trimmed))
    .map((bot) => ({
      id: `bot-${bot.id}`,
      group: "Bots" as const,
      label: bot.name,
      icon: ({ className }: { className?: string }) => (
        <span className={cn("contents", className)}>
          <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={18} />
        </span>
      ),
      go: go(
        () =>
          void navigate({
            to: "/bots/$agentId",
            params: { agentId: bot.id },
          }),
      ),
    }));

  const channels: ChannelSummary[] = searching
    ? searchSettling
      ? []
      : (search.data ?? [])
    : trimmed
      ? []
      : (recent.data ?? []).slice(0, RECENT);
  const conversationResults: Result[] = channels.map((channel) => ({
    id: `conversation-${channel.id}`,
    group: "Conversations" as const,
    label: conversationTitle(channel),
    detail: channel.name,
    icon: IconMessage,
    go: go(
      () =>
        void navigate({
          // Two or more Bots is a group conversation, as the sidebar opens it.
          to:
            channel.agentIds.length > 1
              ? "/group/$channelId"
              : "/channel/$channelId",
          params: { channelId: channel.id },
        }),
    ),
  }));

  const results = [...pages, ...botResults, ...conversationResults];
  const shown = Math.min(active, Math.max(0, results.length - 1));
  const activeResult = results[shown];

  // Back to the top whenever the words change, so Enter opens the best match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the query alone.
  useEffect(() => setActive(0), [trimmed]);
  // The active row stays in view as the arrows move it.
  useEffect(() => {
    if (!activeResult) return;
    document
      .getElementById(`${id}-${activeResult.id}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeResult, id]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An input method's Enter picks a character; it isn't this menu's.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(results.length ? (shown + 1) % results.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(
        results.length ? (shown - 1 + results.length) % results.length : 0,
      );
    } else if (event.key === "Home" && results.length) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && results.length) {
      event.preventDefault();
      setActive(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activeResult?.go();
    }
  };

  const searchPending =
    searching && (searchSettling || search.isPending || search.isFetching);
  const searchFailed = searching && !searchSettling && search.isError;
  const status = !searching
    ? trimmed.length === 1
      ? "Type at least 2 characters to search conversations."
      : `${results.length} ${results.length === 1 ? "result" : "results"}`
    : searchPending && !conversationResults.length
      ? "Searching conversations…"
      : searchFailed
        ? "Couldn't search conversations."
        : `${results.length} ${results.length === 1 ? "result" : "results"}`;

  const groups = (["Pages", "Bots", "Conversations"] as const)
    .map((group) => ({
      group,
      items: results.filter((result) => result.group === group),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <DialogContent
      className="top-[12svh] max-h-[76svh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      finalFocus={() => !navigated.current}
      showCloseButton={false}
    >
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Open a page, a Bot or a conversation. Conversations are searched by
        their names and recent messages.
      </DialogDescription>
      <div className="flex items-center gap-2 border-border border-b px-3">
        <IconSearch
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <input
          aria-activedescendant={
            activeResult ? `${id}-${activeResult.id}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-expanded="true"
          aria-label="Search pages, Bots and conversations"
          autoComplete="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search pages, Bots and conversations"
          role="combobox"
          spellCheck={false}
          type="text"
          value={query}
        />
      </div>
      {/* Said once per change, never per row. */}
      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div aria-label="Results" id={`${id}-list`} role="listbox">
          {groups.map(({ group, items }) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox, as ARIA spells it.
            <div
              aria-labelledby={`${id}-${group}`}
              className="mb-2 last:mb-0"
              key={group}
              role="group"
            >
              <div
                className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs"
                id={`${id}-${group}`}
                role="presentation"
              >
                {group}
              </div>
              {items.map((result) => {
                const Icon = result.icon;
                const isActive = result === activeResult;
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the box; the box names the active option.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the box's arrows and Enter are the keyboard path.
                  <div
                    aria-selected={isActive}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm",
                      isActive ? "bg-muted text-foreground" : "text-foreground",
                    )}
                    id={`${id}-${result.id}`}
                    key={result.id}
                    onClick={result.go}
                    onMouseMove={() => {
                      if (!isActive) setActive(results.indexOf(result));
                    }}
                    role="option"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {result.label}
                    </span>
                    {result.detail ? (
                      <span className="max-w-[40%] shrink-0 truncate text-muted-foreground text-xs">
                        {result.detail}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {/* Outside the list: a button is not an option. The pages and Bots stay whatever this says. */}
        <ConversationsNote
          failed={searchFailed}
          hasMore={searching && !searchSettling && search.hasNextPage}
          loadingMore={search.isFetchingNextPage}
          none={
            searching &&
            !searchSettling &&
            search.isSuccess &&
            !conversationResults.length
          }
          onLoadMore={() => void search.fetchNextPage()}
          onRetry={() => void search.refetch()}
          pending={searchPending && !conversationResults.length}
          shortQuery={trimmed.length > 0 && !searching}
        />
        {!results.length && !searching && trimmed.length > 1 ? (
          <p className="px-2 py-6 text-center text-muted-foreground text-sm">
            No matches.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span>Searches conversation names and recent messages.</span>
        <span className="hidden gap-1 sm:flex">
          <kbd className="rounded border bg-muted px-1 font-sans">↑↓</kbd>
          <kbd className="rounded border bg-muted px-1 font-sans">Enter</kbd>
          <kbd className="rounded border bg-muted px-1 font-sans">Esc</kbd>
        </span>
      </div>
    </DialogContent>
  );
}

/** What the Conversations group says when it has no rows to show, or more to load. */
function ConversationsNote({
  pending,
  failed,
  none,
  shortQuery,
  hasMore,
  loadingMore,
  onRetry,
  onLoadMore,
}: {
  pending: boolean;
  failed: boolean;
  none: boolean;
  shortQuery: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const line = "px-2 py-1.5 text-muted-foreground text-sm";
  if (shortQuery)
    return (
      <p className={line}>Type at least 2 characters to search history.</p>
    );
  if (pending) return <p className={line}>Searching conversations…</p>;
  if (failed)
    return (
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <p className="text-destructive text-sm">
          Couldn't search conversations.
        </p>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          Retry
        </Button>
      </div>
    );
  if (none) return <p className={line}>No conversations match.</p>;
  if (hasMore)
    return (
      <div className="px-2 py-1">
        <Button
          disabled={loadingMore}
          onClick={onLoadMore}
          size="sm"
          type="button"
          variant="ghost"
        >
          {loadingMore ? "Loading…" : "Load more results"}
        </Button>
      </div>
    );
  return null;
}
