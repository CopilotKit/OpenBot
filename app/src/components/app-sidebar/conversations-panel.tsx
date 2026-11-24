import { IconMessagePlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SectionPanel } from "@/components/layout/section-panel";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
  channelSearchInfiniteQueryOptions,
  isChannelSearchable,
  normalizeChannelSearch,
} from "@/lib/channels/queries";
import { loadFailure } from "@/lib/load-failure";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTimeShort } from "@/lib/relative-time";
import {
  type ConversationView,
  useConversationView,
} from "@/lib/settings/conversation-view";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The loaded roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, its opening and the last message, because those are the
 * things the row can actually show — searching against something invisible returns results a person
 * cannot account for. The opening and the last message are included because one of them is what the
 * second line draws until the conversation has been named.
 *
 * Only what is loaded. This sidebar asks the server instead (see `SearchResults`), which searches
 * the whole history; the alternate skins' rosters still narrow their loaded rows with this.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.opening, channel.lastMessage].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

/** How long typing has to pause before the box is searched. */
export const SEARCH_DEBOUNCE_MS = 250;

/** What the search box searches, said where the person types. Not every word of every message. */
export const SEARCH_SCOPE = "Search conversation names and recent messages";
export const SEARCH_HINT = "Type at least 2 characters to search history";

/**
 * `value`, once it has stopped changing for `delay`. Each search is a request, so one per pause in
 * typing rather than one per keystroke.
 */
function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
  view,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
  view: ConversationView;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        view={view}
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        untitled={untitledLine(channel)}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTimeShort(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        canRename={channel.canRename ?? false}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
  );
}

/**
 * What the server found for the search box, a page at a time.
 *
 * The answer is for the text in the box or it is not shown: while the box is still settling, or the
 * first page is on its way, this says it is searching. A list left over from what was typed a
 * moment ago would answer a question nobody is asking any more, and an empty one would say there
 * is nothing to find. A failure says so and offers Retry. It is never shown as no matches.
 *
 * FILTERING DOES NOT ANIMATE. The rows are drawn without the roster's order animation: results
 * replace each other as somebody types, and a list that moves under them is the very thing they
 * are trying to read.
 */
function SearchResults({
  term,
  settled,
  emphasis,
  view,
}: {
  /** The search as it was when typing last paused, normalised. This is what is asked for. */
  term: string;
  /** Whether that is still what is in the box. */
  settled: boolean;
  emphasis: MessageListEmphasis;
  view: ConversationView;
}) {
  const results = useInfiniteQuery(channelSearchInfiniteQueryOptions(term));

  if (!settled || results.isPending) {
    return (
      <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
        Searching…
      </p>
    );
  }
  if (!results.data) {
    return (
      <div className="px-2 py-3 text-center">
        <p role="alert" className="mb-2 text-xs text-muted-foreground">
          {loadFailure(
            results.error,
            results.error?.message || "Couldn't search your conversations.",
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs"
          disabled={results.isFetching}
          onClick={() => void results.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (results.data.length === 0) {
    return (
      <div className="py-4">
        <Empty className="border border-dashed min-h-[40dvh] px-2">
          <EmptyHeader>
            <EmptyTitle>No conversations match your search</EmptyTitle>
            <EmptyDescription className="text-pretty">
              {`No conversation has “${term}” in its name or recent messages.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <>
      {/* Mounted with its first rows, so they appear without the entrance a new channel gets. */}
      <AnimatePresence initial={false}>
        {results.data.map((channel) => (
          <ChannelRow
            view={view}
            emphasis={emphasis}
            key={channel.id}
            animateOrder={false}
            channel={channel}
          />
        ))}
      </AnimatePresence>
      {results.hasNextPage ? (
        <div className="px-2 py-3 text-center">
          {results.isFetchNextPageError ? (
            <p role="alert" className="mb-2 text-xs text-muted-foreground">
              {loadFailure(results.error, "Couldn't load more results.")}
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs"
            disabled={results.isFetching}
            onClick={() => void results.fetchNextPage({ cancelRefetch: false })}
          >
            {results.isFetchingNextPage
              ? "Loading more results…"
              : results.isFetchNextPageError
                ? "Retry"
                : "Load more results"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The Conversations section's panel: every conversation, pinned first and newest first after, with
 * a search over the whole history and New conversation at the top. Today's roster, moved beside the
 * strip and otherwise unchanged.
 */
export function ConversationsPanel({ hidden = false }: { hidden?: boolean }) {
  const emphasis = useMessageListEmphasis();
  const [view] = useConversationView();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const term = normalizeChannelSearch(search);
  const debouncedTerm = normalizeChannelSearch(debouncedSearch);
  const searching = term.length > 0;
  const searchable = isChannelSearchable(term);
  /*
   * WHILE SEARCHING, THE ROSTER IS NOT ON SCREEN. Its rows and its pagination unmount, so nothing
   * pages through recent history looking for a match: the server searches all of it. Clearing the
   * box puts the roster back as it was, scrolled where it was.
   */
  const rosterScroll = useRef<number | null>(null);
  const changeSearch = (value: string) => {
    if (!searching && normalizeChannelSearch(value)) {
      rosterScroll.current = scrollRoot.current?.scrollTop ?? 0;
    }
    setSearch(value);
  };
  useLayoutEffect(() => {
    if (searching || rosterScroll.current === null || !scrollRoot.current) {
      return;
    }
    scrollRoot.current.scrollTop = rosterScroll.current;
    rosterScroll.current = null;
  }, [searching]);
  const visibleChannels = pinnedFirst(channels.data ?? []);
  const animateOrder = (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  return (
    <SectionPanel
      // Folded away with the panel, so a keyboard never tabs into rows nobody can see.
      className="group-data-[collapsible=icon]:hidden"
      hidden={hidden}
      title="Conversations"
      actions={
        // The sidebar's hover rather than `muted`, which is nearly the sidebar's own colour.
        <Button
          aria-label="New conversation"
          className="hover:bg-foreground/5 dark:hover:bg-foreground/5"
          size="icon"
          variant="ghost"
          render={(props) => (
            <Link
              {...props}
              to="/channel/new"
              activeProps={{
                className: "bg-foreground/5",
              }}
            />
          )}
        >
          <IconMessagePlus />
        </Button>
      }
    >
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px pt-0">
            <SidebarMenuItem>
              <InputGroup className="bg-background text-sm rounded-lg h-9">
                <InputGroupInput
                  aria-label="Search conversations"
                  aria-describedby={
                    searching ? "conversation-search-scope" : undefined
                  }
                  onChange={(event) => changeSearch(event.target.value)}
                  placeholder="Search…"
                  value={search}
                />
                <InputGroupAddon>
                  <IconSearch />
                </InputGroupAddon>
              </InputGroup>
            </SidebarMenuItem>
            {/*
             * What is searched, said while somebody types: names and the recent lines the rows
             * show, not every message of every conversation. One character is not searched at
             * all, and says how many it takes, so a box that does nothing never looks broken.
             */}
            {searching ? (
              <p
                id="conversation-search-scope"
                className="px-2 pt-1.5 text-xs text-muted-foreground"
              >
                {searchable ? SEARCH_SCOPE : SEARCH_HINT}
              </p>
            ) : null}
            <div className="w-full h-2" />
            {searching ? (
              searchable ? (
                <SearchResults
                  view={view}
                  emphasis={emphasis}
                  settled={debouncedTerm === term}
                  term={debouncedTerm}
                />
              ) : null
            ) : (
              <>
                {/*
                 * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody
                 * has used yet needs telling how to start; a search that matches nothing says so
                 * and quotes it back (see SearchResults). Told "you don't have channels yet" while
                 * holding a typo, a person reads their conversations as gone.
                 */}
                {channels.data?.length === 0 ? (
                  <div className="py-4">
                    {/*
                     * Narrow at the sides (`px-2`, where `Empty` has 24px), so the panel at its
                     * floor still reads "No conversations yet" on one line, not a word a line.
                     */}
                    <Empty className="border border-dashed min-h-[40dvh] px-2">
                      <EmptyHeader>
                        <EmptyTitle>No conversations yet</EmptyTitle>
                        <EmptyDescription className="text-pretty">
                          Start a conversation with a Bot and it shows up here.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </div>
                ) : null}
                <AnimatePresence initial={false}>
                  {visibleChannels.map((channel) => (
                    <ChannelRow
                      view={view}
                      emphasis={emphasis}
                      key={channel.id}
                      animateOrder={animateOrder}
                      channel={channel}
                    />
                  ))}
                </AnimatePresence>
                {/* Never searching here: a search unmounts the roster, this with it. */}
                <ChannelPagination
                  query={channels}
                  scrollRoot={scrollRoot}
                  searching={false}
                />
              </>
            )}
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
    </SectionPanel>
  );
}
