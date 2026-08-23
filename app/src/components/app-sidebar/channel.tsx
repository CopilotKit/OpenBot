import { IconDots } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { deleteChannelMutationOptions } from "@/lib/channels/mutations";
import { ChannelAvatar } from "../channels/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

// No longer `memo`: the delete dialog needs its own open state and the current route's channel id,
// both independent of the props `use-channel-events` keeps stable.
export function Channel({
  channelId,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // `strict: false`: this row renders in the sidebar on every screen, not only while its own
  // channel is open, so there may be no `channelId` route param to read at all.
  const { channelId: openChannelId } = useParams({ strict: false });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));

  const handleDelete = async () => {
    // Navigate away first: the row this menu lives on unmounts the moment the list invalidates,
    // and a screen still pointed at a channel id that no longer resolves is worse than a screen
    // that moved on a beat early.
    if (openChannelId === channelId) {
      await navigate({ to: "/" });
    }
    deleteChannel.mutate(channelId);
  };

  return (
    <div className="group/channel relative">
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
          <ChannelAvatar participantIds={participantIds} size={32} />
        </div>
        <div className="flex-col min-w-0 flex-1">
          <div className="flex flex-row items-center justify-between gap-2">
            <span className="text-[14px] tracking-[-1%] truncate">{name}</span>
            <div className="group-hover/channel:invisible text-[12px] text-muted-foreground/70">
              {lastMessageAt}
            </div>
          </div>
          <div className="mt-px flex h-4 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
              {lastMessage}
            </span>
          </div>
        </div>
      </Link>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/channel:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Options for ${name}`}
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {/* Only opens the dialog below; the menu closes on click, too early to confirm anything. */}
              <DropdownMenuItem
                onClick={() => setDeleteDialogOpen(true)}
                variant="destructive"
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes your conversation with{" "}
              <span className="font-medium text-foreground">{name}</span>,
              including its message history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteChannel.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteChannel.isPending}
              onClick={() => void handleDelete()}
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
