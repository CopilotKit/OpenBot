import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
import { createProjectMutationOptions } from "@/lib/projects/mutations";
import type { Project } from "@/lib/projects/queries";

/**
 * Makes a folder from wherever the person is.
 *
 * The Projects section has its own inline box beside the "+", which is the usual way in. This one
 * exists for the other way: a conversation's menu, where the folder the conversation should go into
 * does not exist yet, and leaving the menu to make it first would lose the row that was right
 * there. `onCreated` is what files the conversation into the new folder without a second trip.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: Project) => void;
}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const create = useMutation(createProjectMutationOptions(queryClient));
  const [draft, setDraft] = useState("");

  const save = async () => {
    let project: Project;
    try {
      project = await create.mutateAsync(draft);
    } catch {
      // The failure is on the mutation and drawn below; staying open says "not done".
      return;
    }
    setDraft("");
    create.reset();
    onOpenChange(false);
    onCreated?.(project);
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setDraft("");
          create.reset();
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A folder for conversations of your own. Nobody else sees it, and moving a
            conversation into it changes nothing about who can open it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending) void save();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                disabled={create.isPending}
                id={`${formId}-name`}
                maxLength={60}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Website redesign"
                value={draft}
              />
            </Field>
          </form>
          {create.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={create.isPending || draft.trim().length === 0}
            form={formId}
            size="sm"
            type="submit"
          >
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}