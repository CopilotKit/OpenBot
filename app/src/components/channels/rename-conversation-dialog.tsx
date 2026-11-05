import { IconPencil } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { renameChannelMutationOptions } from "@/lib/channels/mutations";

/**
 * Names a conversation, in a dialog that starts from whatever it is called now.
 *
 * Shared by the sidebar row's menu and the Bot panel beside an open conversation, like
 * DeleteConversationDialog, so both ask the same question and fail the same way. The input starts
 * from the conversation's own title — the summary, which is what the roster shows — and never from
 * the Bot's name, which is who the conversation is with rather than what it is about.
 */

/**
 * The title a person typed, as the one line the roster can draw — or nothing worth sending.
 *
 * The same flattening the server applies (`oneLine` in server/src/channels/text.ts): control
 * characters stripped, whitespace collapsed. MIRRORED HERE rather than trusted to the server so the
 * dialog can refuse an empty attempt without a round trip — and so what is sent is what the caller
 * already saw, rather than a sentence the server made of it.
 *
 * The LENGTH CAP is deliberately not mirrored: the server cuts at the titler's cap and answers with
 * the title as it landed, which the dialog shows once it lands. Pre-cutting here would put the
 * ellipsis on screen before the person finished typing, for a limit they cannot see.
 */
export function renameableTitle(value: string): string | null {
  // Whitespace collapsed, same as the server's `oneLine`; the server additionally strips control
  // characters and answers 400 when nothing is left, so this only needs to refuse the obvious.
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > 0 ? flattened : null;
}

export function RenameConversationDialog({
  channelId,
  current,
  name,
  onOpenChange,
  open,
}: {
  channelId: string;
  /** The conversation's title today, or nothing when nothing has named it. */
  current: string | undefined;
  /** The conversation's Bot name, named in the dialog's own heading only. */
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const rename = useMutation(renameChannelMutationOptions(queryClient));
  const { reset } = rename;
  const [draft, setDraft] = useState("");

  // A refusal from a previous attempt is not news about this one, and the box starts from what the
  // conversation is called now — read on open rather than kept in step with `current`, so a rename
  // that lands elsewhere while the dialog is closed is what the next open shows.
  useEffect(() => {
    if (open) {
      reset();
      setDraft(current ?? "");
    }
  }, [open, current, reset]);

  const title = renameableTitle(draft);

  const confirm = async () => {
    if (title === null) return;
    try {
      await rename.mutateAsync({ channelId, name: title });
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
          <DialogTitle>Rename {name}</DialogTitle>
          <DialogDescription>
            The conversation's name, in your sidebar and everybody else's.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Conversation name"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, exactly as the delete dialog's button does — but never a disabled send,
            // which is what the button below refuses and what a keypress would otherwise bypass.
            if (event.key === "Enter" && title !== null && !rename.isPending) {
              void confirm();
            }
          }}
          placeholder="Name this conversation"
          value={draft}
        />
        {rename.error ? (
          <p className="text-destructive text-sm">{rename.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={title === null || rename.isPending}
            onClick={() => {
              void confirm();
            }}
            size="sm"
          >
            <IconPencil />
            {rename.isPending ? "Renaming…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
