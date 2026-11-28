import { IconMessage, IconMessagePlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import {
  ChannelRow,
  NONE_DELEGATING,
  pinnedFirst,
  SEARCH_DEBOUNCE_MS,
  SEARCH_HINT,
  SEARCH_SCOPE,
  SearchResults,
  useDebounced,
} from "@/components/app-sidebar/conversations-panel";
import { ShellAccountMenu } from "@/components/layout/native-shell-account";
import { ShellChats } from "@/components/layout/native-shell-panels";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  channelListQueryOptions,
  isChannelSearchable,
  normalizeChannelSearch,
} from "@/lib/channels/queries";
import { loadFailure } from "@/lib/load-failure";
import { nativeShell } from "@/lib/native-shell/shell";
import { useConversationView } from "@/lib/settings/conversation-view";
import { useMessageListEmphasis } from "@/lib/settings/message-list";
import { delegatingConversationsQueryOptions } from "@/lib/tasks/queries";

export const Route = createFileRoute("/_authed/_app/conversations")({
  component: ConversationsRoute,
});

/**
 * In the phone app's native shell, the Chats tab, which is the sidebar's Conversations panel itself
 * (`ShellChats`); in a browser, the page below.
 */
function ConversationsRoute() {
  return nativeShell() ? <ShellChats /> : <ConversationsPage />;
}

/** Above this many rows a re-sort is not animated, as in the sidebar. */
const MAX_ANIMATED_ROWS = 60;

/**
 * Every conversation, as a page: the sidebar's Conversations panel for a screen with no sidebar
 * (the phone app's native shell, whose Conversations tab opens it), and at its own address in a
 * browser too. The same list, read the same way: pinned first, then newest, unread marked, the
 * same search over the whole history, and New conversation where the panel has it. The rows are
 * the sidebar's (`Channel`), so pressing and holding one (or right-clicking it) pins, renames or
 * deletes it there as well.
 *
 * Not virtualized, as the sidebar is not: rows off screen are skipped by `content-visibility`, and
 * older ones are read a page at a time as the list is scrolled to its end.
 */
function ConversationsPage() {
  const emphasis = useMessageListEmphasis();
  const [view] = useConversationView();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const delegating =
    useQuery(delegatingConversationsQueryOptions()).data ?? NONE_DELEGATING;
  const [search, setSearch] = useState("");
  const debouncedTerm = normalizeChannelSearch(
    useDebounced(search, SEARCH_DEBOUNCE_MS),
  );
  const term = normalizeChannelSearch(search);
  const searching = term.length > 0;
  const searchable = isChannelSearchable(term);
  const rows = pinnedFirst(channels.data ?? []);
  const shell = nativeShell() !== null;

  return (
    <PageShell
      action={
        <div className="flex items-center gap-2">
          {/*
           * Beside the account in the native shell, the icon alone, named for a screen reader: the
           * words and the avatar do not both fit beside the title on a phone.
           */}
          {shell ? (
            <Button
              aria-label="New conversation"
              // A whole tap target, as tall as the account beside it; the icon keeps its size.
              className="size-11"
              render={(props) => <Link {...props} to="/channel/new" />}
              size="icon"
              variant="ghost"
            >
              <IconMessagePlus />
            </Button>
          ) : (
            <Button
              render={(props) => <Link {...props} to="/channel/new" />}
              size="sm"
              variant="ghost"
            >
              <IconMessagePlus />
              New conversation
            </Button>
          )}
          <ShellAccountMenu />
        </div>
      }
      title="Conversations"
    >
      {/* Nothing to search before there is a list: the box comes with it. */}
      {channels.data && channels.data.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <InputGroup className="h-9 border-transparent bg-muted/60 shadow-none">
            <InputGroupAddon>
              <IconSearch aria-hidden="true" className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              aria-describedby={
                searching ? "conversations-search-scope" : undefined
              }
              aria-label="Search conversations"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations"
              value={search}
            />
          </InputGroup>
          {searching ? (
            <p
              className="text-xs text-muted-foreground"
              id="conversations-search-scope"
            >
              {searchable ? SEARCH_SCOPE : SEARCH_HINT}
            </p>
          ) : null}
        </div>
      ) : null}
      {searching ? (
        searchable ? (
          <SearchResults
            delegating={delegating}
            emphasis={emphasis}
            layout="page"
            settled={debouncedTerm === term}
            term={debouncedTerm}
            view={view}
          />
        ) : null
      ) : channels.isPending ? null : channels.data === undefined ? (
        // Only when nothing ever loaded: a failed refetch keeps the list it had.
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive text-sm" role="alert">
            {loadFailure(
              channels.error,
              "Couldn't load your conversations. Try again in a moment.",
            )}
          </p>
          <Button
            disabled={channels.isFetching}
            onClick={() => void channels.refetch()}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/channel/new" />}
              size="sm"
              variant="outline"
            >
              <IconMessagePlus />
              New conversation
            </Button>
          }
          icon={IconMessage}
          title="No conversations yet"
        >
          Start a conversation with a Bot and it shows up here.
        </PageEmpty>
      ) : (
        <>
          <PageRows>
            <AnimatePresence initial={false}>
              {rows.map((channel, index) => (
                <ChannelRow
                  animateOrder={rows.length <= MAX_ANIMATED_ROWS}
                  channel={channel}
                  delegating={delegating}
                  divided={index > 0}
                  emphasis={emphasis}
                  key={channel.id}
                  layout="page"
                  view={view}
                />
              ))}
            </AnimatePresence>
          </PageRows>
          <ChannelPagination
            query={channels}
            scrollRoot={null}
            searching={false}
          />
        </>
      )}
    </PageShell>
  );
}
