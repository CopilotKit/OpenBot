import { IconPin, IconPinnedOff, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { useTypedReveal } from "@/lib/typed-reveal";
import { ChannelItemContent } from "./channel-item-content";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin and Delete. Deleting is confirmed in a dialog that names the channel,
 * because the row it was invoked on is one of several identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  summary,
  lastMessage,
  lastMessageAt,
  pinned,
  unread,
  busy,
  emphasis,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  /** What the conversation is about, once named. The channel name only says which Bot it is. */
  summary?: string;
  /** Used as the thread title until the conversation has been named. */
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
  unread: boolean;
  busy: boolean;
  emphasis: MessageListEmphasis;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's channel is the one on screen, as a boolean, so navigating between
  // channels re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  /* Types in only on arrival; an already-named row draws it outright. */
  const revealed = useTypedReveal(summary);
  const threadTitle = revealed.text || lastMessage || "New conversation";
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  /**
   * Why a pin did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. There is no toast in this
   * app, and the row is where the person was looking, so the sentence goes here and is replaced by
   * the next attempt.
   */
  const [pinProblem, setPinProblem] = useState<string | null>(null);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            // Two or more Bots is a group conversation, which has its own shared transcript.
            to={
              participantIds.length > 1
                ? "/group/$channelId"
                : "/channel/$channelId"
            }
            params={{ channelId }}
            type="button"
            className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
            activeProps={{
              className: "bg-foreground/5",
            }}
          >
            <ChannelItemContent
              participantIds={participantIds}
              name={name}
              title={summary || lastMessage || "New conversation"}
              displayedTitle={threadTitle}
              lastMessageAt={lastMessageAt}
              emphasis={emphasis}
              busy={busy}
              unread={unread}
              pinned={pinned}
              revealing={revealed.typing}
            />
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setPinProblem(null);
              setPinned.mutate(
                { channelId, pinned: !pinned },
                { onError: (thrown) => setPinProblem(thrown.message) },
              );
            }}
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "Unpin conversation" : "Pin conversation"}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            <IconTrash />
            Delete conversation…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <DeleteConversationDialog
        channelId={channelId}
        // Away first when this row's channel is the one on screen.
        leave={isOpen ? () => navigate({ to: "/" }) : undefined}
        name={name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </>
  );
});
