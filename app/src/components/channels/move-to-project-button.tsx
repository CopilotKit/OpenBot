import { IconFolderMinus, IconFolderPlus, IconPlus } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { NewProjectDialog } from "@/components/app-sidebar/new-project-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { moveToProjectOffers } from "@/lib/channels/sections";
import { moveChannelToProjectMutationOptions } from "@/lib/projects/mutations";
import { projectsQueryOptions } from "@/lib/projects/queries";

/**
 * "Move to project…", for the panel beside an open conversation.
 *
 * The sidebar's right-click menu is the fastest way in, but a menu nobody is told about is a menu
 * nobody finds; the panel is where a person already looking at the conversation goes to do things to
 * it. The offers and the refusal are the menu's: every folder but the one it is in, the way to a
 * folder that does not exist yet, the way back out when it is filed somewhere, and the server's
 * sentence when the move did not take — said inside the dialog, which stays open on a refusal.
 */
export function MoveToProjectButton({
  channelId,
  label = "Move to project…",
}: {
  channelId: string;
  /** The group's People dialog calls it "File in project…" so it reads as about the group. */
  label?: string;
}) {
  const queryClient = useQueryClient();
  // Where this conversation is filed, from the sidebar's list rather than a request of its own: the
  // list is already loaded wherever the panel is drawn, and the detail read does not carry it.
  const filedIn = useInfiniteQueryFiledProject(channelId);
  const projects = useQuery(projectsQueryOptions()).data;
  const move = useMutation(moveChannelToProjectMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const offers = moveToProjectOffers(projects, filedIn);

  // Filed through the promise, like the menu: "New project…" closes this dialog to open its own,
  // and a refusal reported to an unmounted observer is reported to nobody.
  const file = (projectId: string | null) =>
    move
      .mutateAsync({ channelId, projectId })
      .then(() => {
        move.reset();
        setOpen(false);
      })
      .catch(() => {
        // The error is on the mutation and drawn in the dialog; staying open says "not done".
      });

  return (
    <>
      <Button
        aria-label={label}
        className="w-full text-sm!"
        onClick={() => {
          move.reset();
          setOpen(true);
        }}
        variant="outline"
      >
        <IconFolderPlus />
        {label}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to project</DialogTitle>
            <DialogDescription>
              Your folders, and only yours: where this conversation sits is
              yours alone, and everybody else files it as they like.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 grid gap-1">
            {offers.map((offer) =>
              offer.kind === "project" ? (
                <Button
                  key={offer.projectId}
                  disabled={move.isPending}
                  onClick={() => file(offer.projectId)}
                  variant="ghost"
                >
                  <IconFolderPlus />
                  {offer.name}
                </Button>
              ) : (
                <Button
                  key="new"
                  onClick={() => {
                    setOpen(false);
                    setCreating(true);
                  }}
                  variant="ghost"
                >
                  <IconPlus />
                  New project…
                </Button>
              ),
            )}
            {filedIn ? (
              <Button
                disabled={move.isPending}
                onClick={() => file(null)}
                variant="ghost"
              >
                <IconFolderMinus />
                Remove from project
              </Button>
            ) : null}
            {move.error ? (
              <p className="text-destructive text-sm" role="alert">
                {move.error.message}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
      {/* The folder is made first, then this conversation is filed into it. */}
      <NewProjectDialog
        onCreated={(project) => file(project.id)}
        onOpenChange={setCreating}
        open={creating}
      />
    </>
  );
}

/**
 * The folder this conversation is filed in, or null for none, off the sidebar's paged list.
 *
 * The list's first page always holds every pinned conversation, and a conversation outside the
 * pages loaded so far cannot be pinned — but it can be filed anywhere, so "not in the pages yet"
 * means "unknown" and is drawn as unfiled rather than asserted as fact. The same hedge the pin
 * beside this button makes.
 */
function useInfiniteQueryFiledProject(channelId: string) {
  return useInfiniteQuery({
    ...channelListQueryOptions(),
    select: (data) => {
      for (const page of data.pages) {
        const channel = page.channels.find((row) => row.id === channelId);
        if (channel) return channel.projectId ?? null;
      }
      return null;
    },
  }).data;
}
