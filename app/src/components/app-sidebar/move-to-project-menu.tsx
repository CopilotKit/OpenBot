import {
  IconFolderMinus,
  IconFolderPlus,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { moveToProjectOffers } from "@/lib/channels/sections";
import { moveChannelToProjectMutationOptions } from "@/lib/projects/mutations";
import type { Project } from "@/lib/projects/queries";
import { NewProjectDialog } from "./new-project-dialog";

/**
 * "Move to project ▸" and "Remove from project", for one conversation's menu.
 *
 * Only ever the caller's own folders, because the folder list came from `/api/projects`, which is
 * owner-scoped; and only ever on a row the roster drew, which it draws for members. So what the
 * server enforces — owner files, member moves — is what this menu can offer.
 *
 * A refused move is said on the row that asked, like a refused pin: the menu has closed by then and
 * a conversation that quietly stayed where it was reads as a click that did nothing.
 */
export function MoveToProjectMenu({
  channelId,
  currentProjectId,
  projects,
  onProblem,
}: {
  channelId: string;
  /** The folder this conversation is filed in, or null. Decides whether "Remove" is offered. */
  currentProjectId: string | null;
  projects: Project[];
  onProblem: (problem: string) => void;
}) {
  const queryClient = useQueryClient();
  const move = useMutation(moveChannelToProjectMutationOptions(queryClient));
  const [creating, setCreating] = useState(false);
  const offers = moveToProjectOffers(projects, currentProjectId);

  const file = (projectId: string | null) =>
    move.mutate(
      { channelId, projectId },
      { onError: (error) => onProblem(error.message) },
    );

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <IconFolderPlus />
          Move to project
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {offers.map((offer) =>
            offer.kind === "project" ? (
              <ContextMenuItem
                key={offer.projectId}
                onClick={() => file(offer.projectId)}
              >
                {offer.name}
              </ContextMenuItem>
            ) : (
              <Fragment key="new">
                {/* The way to a folder that does not exist yet reads as its own choice, not as
                    one of the folders. */}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => setCreating(true)}>
                  <IconPlus />
                  New project…
                </ContextMenuItem>
              </Fragment>
            ),
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {currentProjectId ? (
        <ContextMenuItem onClick={() => file(null)}>
          <IconFolderMinus />
          Remove from project
        </ContextMenuItem>
      ) : null}
      {/* The folder is made first, then this conversation is filed into it — the row stays in the
          menu it was opened from while the dialog explains itself. */}
      <NewProjectDialog
        onCreated={(project) => file(project.id)}
        onOpenChange={setCreating}
        open={creating}
      />
    </>
  );
}