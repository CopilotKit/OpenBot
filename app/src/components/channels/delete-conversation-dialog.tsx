import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEdition } from "@/components/edition/for-a-team";
import { deleteChannelMutationOptions } from "@/lib/channels/mutations";
import { deleteQuestion } from "@/lib/delete-question";

/**
 * The question, naming the conversation by what the sidebar calls it (`conversationTitle`). A
 * conversation nobody has used yet has no name to quote.
 */
export function deleteConversationQuestion(title: string): string {
  return deleteQuestion(title, "Delete this conversation?");
}

/**
 * What deleting it does. Only a team has other people in a conversation, so only a team is told it
 * goes for everyone. The personal edition has one person, and an edition not known yet is told
 * nothing that could be wrong for either.
 */
export function deleteConversationOutcome(
  edition: "team" | "personal" | undefined,
): string {
  return edition === "team"
    ? "It disappears for everyone in the conversation."
    : "It's deleted, with all its messages.";
}

/**
 * Confirms deleting a conversation, naming it, and deletes it.
 *
 * `title` is the conversation's own name, never its channel `name`: that is the Bot's for every
 * one-Bot conversation, and "Delete Personal Assistant?" asked about the wrong thing.
 *
 * Shared by the sidebar row's menu and the Bot panel beside an open conversation, so both ask the
 * same question and fail the same way. `leave` runs before the delete when the conversation is the
 * one on screen: the roster invalidates the moment the delete lands, and whatever drew this dialog
 * can unmount while the rest of the work is still owed, leaving somebody looking at a conversation
 * that no longer exists. Leaving first is safe in the other direction: a refused delete puts them on
 * the roster with the conversation still in it, and the dialog says why.
 */
export function DeleteConversationDialog({
  channelId,
  leave,
  onOpenChange,
  open,
  title,
}: {
  channelId: string;
  /** Navigates away from the conversation. Only passed where it is the one on screen. */
  leave?: () => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** What the conversation is called (`conversationTitle`), or empty when it has no name yet. */
  title: string;
}) {
  const queryClient = useQueryClient();
  const edition = useEdition();
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const { reset } = deleteChannel;

  // A refusal from a previous attempt is not news about this one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const confirm = async () => {
    if (leave) await leave();
    try {
      await deleteChannel.mutateAsync(channelId);
    } catch {
      // The error is on the mutation and rendered below; leaving it open says "not done".
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deleteConversationQuestion(title)}</DialogTitle>
          <DialogDescription>
            {deleteConversationOutcome(edition)}
          </DialogDescription>
        </DialogHeader>
        {deleteChannel.error ? (
          <p className="text-destructive text-sm">
            {deleteChannel.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={deleteChannel.isPending}
            onClick={() => {
              void confirm();
            }}
            size="sm"
            variant="destructive"
          >
            {deleteChannel.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
