import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { renameChannelMutationOptions } from "@/lib/channels/mutations";
import { queryClient } from "@/query-client";

/** The server's cap on a chosen name, `MAX_CHOSEN_TITLE_GRAPHEMES`, so the field stops where it does. */
const MAX_NAME_LENGTH = 60;

/**
 * Renames a conversation from the sidebar row's menu.
 *
 * A dialog, like Delete beside it in the same menu, so the row keeps its avatar, time and dots
 * while the name is typed. Enter saves, Escape or Cancel leaves the name as it was, and an empty
 * name gives the conversation back the name OpenBot chose for it.
 */
export function RenameConversationDialog({
  channelId,
  title,
  onOpenChange,
  open,
}: {
  channelId: string;
  /** What the row shows now, to edit from. Empty for a conversation with no name yet. */
  title: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const formId = useId();
  const rename = useMutation(renameChannelMutationOptions(queryClient));
  const { reset } = rename;
  const [draft, setDraft] = useState(title);
  /**
   * The name the row showed when this opening began, or null while closed.
   *
   * Taken once per opening, not followed: a save refetches the roster, and the row's new name
   * arriving while the dialog is still open must not reset the draft or the save under it.
   */
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  if (open && openedWith === null) {
    setOpenedWith(title);
    setDraft(title);
  } else if (!open && openedWith !== null) {
    setOpenedWith(null);
  }

  // A refusal from the last opening is not news about this one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const save = async () => {
    // Unchanged is not a rename: saving it would fix today's name over a later summary.
    if (draft.trim() === (openedWith ?? title).trim()) {
      onOpenChange(false);
      return;
    }
    try {
      await rename.mutateAsync({ channelId, title: draft });
    } catch {
      // The error is on the mutation and rendered below; staying open says "not done".
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            Leave it empty to go back to the name OpenBot chose.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!rename.isPending) void save();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                disabled={rename.isPending}
                id={`${formId}-name`}
                maxLength={MAX_NAME_LENGTH}
                onChange={(event) => {
                  setDraft(event.target.value);
                  reset();
                }}
                // All of it selected, so typing replaces the name and an arrow key keeps it.
                onFocus={(event) => event.currentTarget.select()}
                placeholder="New conversation"
                value={draft}
              />
            </Field>
          </form>
          {rename.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {rename.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={rename.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
