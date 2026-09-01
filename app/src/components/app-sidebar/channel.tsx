import {
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteChannelMutationOptions,
  setChannelPinnedMutationOptions,
} from "@/lib/channels/mutations";
import { ChannelAvatar } from "../channels/avatar";

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
  participantImages,
  name,
  lastMessage,
  lastMessageAt,
  pinned,
  unread,
  busy,
}: {
  channelId: string;
  participantIds: string[];
  participantImages?: (string | null)[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
  unread: boolean;
  busy: boolean;
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
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
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

  const confirmDelete = async () => {
    /*
     * Away first when this row's channel is the one on screen.
     *
     * The roster invalidates the moment the delete lands, so this row — and the dialog living inside
     * it — unmounts while the rest of this function is still owed. Navigating after the mutation
     * therefore ran in a component that was already gone, leaving somebody looking at a conversation
     * that no longer exists. Leaving before asking is safe in the other direction: a refused delete
     * puts them on the roster with the channel still in it, and says why in the dialog.
     */
    if (isOpen) {
      await navigate({ to: "/" });
    }
    try {
      await deleteChannel.mutateAsync(channelId);
    } catch {
      // The error is on the mutation and rendered in the dialog; leaving it open says "not done".
      return;
    }
    setConfirming(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            to="/channel/$channelId"
            params={{ channelId }}
            type="button"
            className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
            activeProps={{
              className: "bg-foreground/5",
            }}
          >
            <div className="">
              <ChannelAvatar
                participantIds={participantIds}
                participantImages={participantImages}
                size={32}
                typing={busy}
              />
            </div>
            <div className="flex-col min-w-0 flex-1">
              <div className="flex flex-row items-center justify-between gap-2">
                <span
                  className={`text-[14px] tracking-[-1%] truncate ${
                    unread ? "font-medium" : ""
                  }`}
                >
                  {name}
                </span>
                <div className="text-[12px] text-muted-foreground/70">
                  {lastMessageAt}
                </div>
              </div>
              <div className="mt-px flex h-4 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
                  {lastMessage}
                </span>
                {unread ? (
                  /* State about the message beats state about the row, so it sits first. */
                  <span className="size-2 shrink-0 rounded-full bg-primary" />
                ) : null}
                {pinned ? (
                  <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
                ) : null}
              </div>
            </div>
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
            {pinned ? "Unpin channel" : "Pin channel"}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              // A refusal from a previous attempt is not news about this one.
              deleteChannel.reset();
              setConfirming(true);
            }}
          >
            <IconTrash />
            Delete channel…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        open={confirming}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              The conversation will no longer appear for anyone in it.
            </DialogDescription>
          </DialogHeader>
          {deleteChannel.error ? (
            <p className="text-destructive text-sm">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="destructive"
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
