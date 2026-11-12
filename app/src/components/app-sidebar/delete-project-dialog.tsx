import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { deleteProjectMutationOptions } from "@/lib/projects/mutations";
import type { Project } from "@/lib/projects/queries";

/**
 * Deletes a folder, and says what that does not do.
 *
 * Confirmed rather than immediate, because the row it was invoked on is one of several
 * identical-looking folder rows — but the sentence matters more than the confirmation: a person
 * deleting a folder has to be able to see that their conversations are not going with it.
 */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation(deleteProjectMutationOptions(queryClient));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{project.name}”?</DialogTitle>
          <DialogDescription>
            The folder goes. Its conversations stay, back under Group chats or
            Direct chats with their messages.
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <DialogBody className="mt-4">
            <p className="text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          </DialogBody>
        ) : null}
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync(project.id);
              } catch {
                return;
              }
              onOpenChange(false);
            }}
            size="sm"
            variant="destructive"
          >
            {remove.isPending ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}