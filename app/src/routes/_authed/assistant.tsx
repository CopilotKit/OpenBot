import { IconDots, IconMessagePlus, IconMinus } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import {
  hasUnseenActivity,
  pinnedFirst,
} from "@/components/app-sidebar/conversations-panel";
import { ConversationApprovals } from "@/components/approvals/inline-approval";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  Composer,
  type ComposerDraft,
  toAgentOptions,
} from "@/components/channels/composer";
import { AssistantBubble } from "@/components/desktop/assistant-bubble";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { untitledLine } from "@/lib/channels/label";
import { conversationLoadFailure } from "@/lib/channels/load-failure";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import {
  type ChannelSummary,
  channelListQueryOptions,
  channelQueryOptions,
  listedChannel,
} from "@/lib/channels/queries";
import {
  CoworkerRoutingRefusedError,
  routeMessage,
} from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { useAttachmentLimits } from "@/lib/deployment/queries";
import { useAssistantLayout } from "@/lib/desktop/assistant";
import {
  collapseAssistantMutationOptions,
  expandAssistantMutationOptions,
  openFullWindowMutationOptions,
  setCompactViewMutationOptions,
} from "@/lib/desktop/mutations";
import { desktopShell } from "@/lib/desktop/shell";
import { appConfig } from "@/lib/generated/application-config";
import { relativeTimeShort } from "@/lib/relative-time";
import { searchTextEntry } from "@/lib/search-text";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * Compact view: OpenBot as a small bubble over the person's other apps, in OpenBot Desktop's second
 * window (desktop/src-tauri/src/assistant.rs). The bubble can be dragged anywhere, and a click opens
 * it into a small panel: the person's conversations down the left, and the one picked beside them,
 * or a box to start a new one. The window is the bubble's size or the panel's, and transparent
 * around them, so the page draws no ground of its own (`data-assistant`, styles.css).
 *
 * A panel folded into its bubble stays mounted, only hidden: a Bot still at work keeps its turn, and
 * a tool it runs in this page, such as using the person's Mac, keeps running.
 *
 * Outside OpenBot Desktop the page is the panel, filling the tab.
 */
export const Route = createFileRoute("/_authed/assistant")({
  // The open conversation, read as text whatever the router parsed it into (`searchText`).
  validateSearch: (
    search: Record<string, unknown>,
  ): { conversation?: string } =>
    searchTextEntry("conversation", search.conversation),
  component: AssistantPage,
});

/** The deployment's own name, from its brand.yaml. */
const PRODUCT = appConfig.brand.productName;

function AssistantPage() {
  useNoGround();
  // The roster's socket, which OpenBot's sidebar opens elsewhere: rows say Working, and new ones come in.
  useChannelEvents();
  const layout = useAssistantLayout();
  const expand = useMutation(expandAssistantMutationOptions(queryClient));
  if (!layout) return null;
  return (
    <>
      <AssistantBubble
        hidden={layout.expanded}
        onOpen={() => expand.mutate()}
      />
      <Panel hidden={!layout.expanded} />
    </>
  );
}

/** Marked as `index.html` marks it before the first paint, for a page reached by navigation. */
function useNoGround() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.assistant = "";
    return () => {
      delete root.dataset.assistant;
    };
  }, []);
}

/** The panel: a header to drag it by, the conversations, and the one open. */
function Panel({ hidden }: { hidden: boolean }) {
  // Not strict, so the page draws under any router that serves it this search (its tests).
  const { conversation } = useSearch({ strict: false });
  const inDesktop = desktopShell() !== null;
  const collapse = useMutation(collapseAssistantMutationOptions(queryClient));
  const openFull = useMutation(openFullWindowMutationOptions());
  const turnOff = useMutation(setCompactViewMutationOptions(queryClient));
  return (
    <div
      className={cn(
        "fixed flex flex-col overflow-hidden bg-background text-foreground",
        // In the desktop app the window is a little larger than the panel, for its shadow.
        inDesktop ? "inset-2 rounded-xl border shadow-xl" : "inset-0",
      )}
      hidden={hidden}
    >
      <header
        className="flex h-11 shrink-0 items-center gap-1 border-b pr-1.5 pl-2"
        // Dragged from anywhere but its buttons (Tauri's drag regions, which the page is granted).
        data-tauri-drag-region="deep"
      >
        <PanelTitle conversation={conversation} />
        <Button
          aria-label="New conversation"
          className="hover:bg-foreground/5"
          render={(props) => <Link {...props} search={{}} to="/assistant" />}
          size="icon-sm"
          variant="ghost"
        >
          <IconMessagePlus />
        </Button>
        {inDesktop ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label="More"
                    className="hover:bg-foreground/5"
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <IconDots />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-44">
                <DropdownMenuItem
                  onClick={() =>
                    openFull.mutate(
                      conversation ? `/channel/${conversation}` : null,
                    )
                  }
                >
                  Open full window
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => turnOff.mutate(false)}>
                  Turn off compact view
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              aria-label="Minimize"
              className="hover:bg-foreground/5"
              onClick={() => collapse.mutate()}
              size="icon-sm"
              variant="ghost"
            >
              <IconMinus />
            </Button>
          </>
        ) : null}
      </header>
      {turnOff.error ? (
        <p className="border-b px-3 py-2 text-sm text-destructive" role="alert">
          Couldn't turn off compact view. Try again.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <ConversationList openId={conversation} />
        <section className="flex min-w-0 flex-1 flex-col">
          {conversation ? (
            <AssistantConversation
              channelId={conversation}
              key={conversation}
              shown={!hidden}
            />
          ) : (
            <AssistantStart />
          )}
        </section>
      </div>
    </div>
  );
}

/** The open conversation's Bot and name, or New conversation. */
function PanelTitle({ conversation }: { conversation: string | undefined }) {
  const channel = useQuery({
    ...channelQueryOptions(conversation ?? ""),
    enabled: conversation !== undefined,
  });
  // Named from the roster while the conversation's own read is on its way, as its page does.
  const named =
    conversation === undefined
      ? undefined
      : (channel.data ?? listedChannel(queryClient, conversation));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
      {named ? (
        <>
          <ChannelAvatar participantIds={named.agentIds} size={20} />
          <span className="min-w-0 truncate text-sm font-medium">
            {named.name}
          </span>
        </>
      ) : conversation === undefined ? (
        <span className="min-w-0 truncate text-sm font-medium">
          New conversation
        </span>
      ) : null}
    </div>
  );
}

/** Every conversation, pinned first and newest after, one line each, as the sidebar's compact rows. */
function ConversationList({ openId }: { openId: string | undefined }) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  return (
    <nav
      aria-label="Conversations"
      className="flex w-52 shrink-0 flex-col border-r bg-sidebar"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {channels.isPending ? null : channels.error ? (
          <p className="p-2 text-xs text-destructive" role="alert">
            Couldn't load your conversations. Try again in a moment.
          </p>
        ) : channels.data.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            No conversations yet. Ask for something to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {pinnedFirst(channels.data).map((channel) => (
              <li key={channel.id}>
                <ConversationRow
                  channel={channel}
                  open={channel.id === openId}
                />
              </li>
            ))}
          </ul>
        )}
        {channels.hasNextPage ? (
          <Button
            className="mt-1 w-full"
            disabled={channels.isFetchingNextPage}
            onClick={() => void channels.fetchNextPage()}
            size="sm"
            variant="ghost"
          >
            {channels.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
      </div>
    </nav>
  );
}

function ConversationRow({
  channel,
  open,
}: {
  channel: ChannelSummary;
  open: boolean;
}) {
  return (
    <Link
      className={cn(
        "flex w-full items-center rounded-lg px-2 py-1.5 hover:bg-foreground/5",
        open && "bg-foreground/5",
      )}
      replace
      search={{ conversation: channel.id }}
      to="/assistant"
    >
      <ChannelItemContent
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
        emphasis="thread"
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTimeShort(channel.lastMessageAt)
            : undefined
        }
        name={channel.name}
        participantIds={channel.agentIds}
        pinned={channel.pinned}
        title={channel.summary || untitledLine(channel) || "New conversation"}
        unread={!open && hasUnseenActivity(channel)}
        view="compact"
      />
    </Link>
  );
}

/**
 * The open conversation: its chat, as on its own page, with what waits on the person above it. A
 * conversation with more than one Bot has a shared transcript this panel doesn't draw, so it opens in
 * the full window.
 *
 * Read only while the panel shows it (`shown`): a reply that comes while the panel is a bubble waits
 * for the person, and the bubble's dot says it is there.
 */
function AssistantConversation({
  channelId,
  shown,
}: {
  channelId: string;
  shown: boolean;
}) {
  const channel = useQuery(channelQueryOptions(channelId));
  const openFull = useMutation(openFullWindowMutationOptions());
  const markRead = shown ? <MarkRead channelId={channelId} /> : null;
  if (channel.isPending) return markRead;
  if (channel.error || !channel.data) {
    return (
      <p className="p-4 text-sm text-destructive" role="alert">
        {conversationLoadFailure(channel.error)}
      </p>
    );
  }
  const data = channel.data;
  const runtimeAgentId =
    data.agentIds.length === 1 ? data.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {markRead}
        <p className="max-w-xs text-sm text-muted-foreground">
          A conversation with more than one Bot opens in the full window.
        </p>
        {desktopShell() ? (
          <Button
            onClick={() => openFull.mutate(`/group/${data.id}`)}
            size="sm"
            variant="outline"
          >
            Open full window
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <>
      {markRead}
      <div className="px-3 pt-2 empty:hidden">
        <ConversationApprovals threadId={data.threadId} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChannelChat
          channel={data}
          key={data.id}
          runtimeAgentId={runtimeAgentId}
        />
      </div>
    </>
  );
}

/** Marks the open conversation read, now and whenever a Bot says more in it, while it is mounted. */
function MarkRead({ channelId }: { channelId: string }) {
  useMarkOpenChannelRead(channelId);
  return null;
}

/**
 * A new conversation, made by its first message. OpenBot picks the Bot it is for, as the home page
 * does, unless the person names one with `@`, and the panel opens it.
 */
function AssistantStart() {
  const agents = useQuery(agentListQueryOptions());
  const attachmentLimits = useAttachmentLimits();
  const navigate = useNavigate();
  const { start, startChosen, pending } = useStartChannel({
    open: (channelId) =>
      navigate({
        replace: true,
        search: { conversation: channelId },
        to: "/assistant",
      }),
  });
  const [error, setError] = useState<string | null>(null);
  const fallback = defaultAgentProfile(
    agents.data,
    agents.data?.find((agent) => agent.visibility === "public"),
  );

  const send = async (draft: ComposerDraft) => {
    setError(null);
    try {
      if (draft.agentId) {
        await startChosen(
          draft.agentId,
          draft.text,
          null,
          undefined,
          draft.attachments,
        );
        return;
      }
      let agentId: string | undefined;
      try {
        agentId = (await routeMessage(draft.text, undefined, draft.commandIds))
          .agentId;
      } catch (caught) {
        if (
          draft.commandIds.length ||
          caught instanceof CoworkerRoutingRefusedError
        )
          throw caught;
        agentId = fallback?.id;
      }
      if (!agentId)
        throw new Error(
          "There's no Bot to send this to. Try again in a moment.",
        );
      await start(agentId, draft.text, null, undefined, draft.attachments);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't start the conversation. Try again.",
      );
      // The box keeps the words, as it does for any send that fails.
      throw caught;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <AgentOrb size="40px" />
        <h1 className="mt-3 text-base font-semibold tracking-tight">
          What can I help with?
        </h1>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          {PRODUCT} picks the right Bot. Type <code>@</code> to choose one.
        </p>
      </div>
      <Composer
        agents={toAgentOptions(agents.data)}
        attachmentLimits={attachmentLimits}
        autoFocus
        compact
        disabled={!fallback}
        holdsFilesUntilSent
        onSubmit={send}
        pending={pending}
      />
      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : agents.isError && agents.data === undefined ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          Couldn't load your Bots. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}
