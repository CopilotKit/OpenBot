import {
  IconCopy,
  IconEyeOff,
  IconPin,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { resetBotMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string, string][] = [
    [plan.conversations, "conversation", "conversations"],
    [plan.memorySources, "memory source", "memory sources"],
    [plan.memories, "imported memory", "imported memories"],
    [plan.routines, "routine", "routines"],
    [plan.responsibilities, "responsibility", "responsibilities"],
    [plan.followUps, "scheduled follow-up", "scheduled follow-ups"],
    [plan.formedMemories, "memory it formed", "memories it formed"],
    [plan.backgroundResearch, "background research", "background research"],
    [plan.standingApprovals, "standing permission", "standing permissions"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}

function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset {agent.name}?</DialogTitle>
          <DialogDescription>
            This deletes what {agent.name} has with you, and only with you.
            Nobody else's conversations or data are touched. It cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              Could not count what a reset would delete.
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">Done. {agent.name} starts fresh with you.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>There is nothing of yours to delete.</p>
              ) : (
                <>
                  <p>This will delete:</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {plan.data.sharedConversationsKept} conversation
                  {plan.data.sharedConversationsKept === 1 ? " is" : "s are"}{" "}
                  shared with other people or Bots and will be kept.
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Your own memories, the ones you told a Bot directly, are kept.
              </p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess ? "Close" : "Cancel"}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending ? "Resetting…" : "Delete and reset"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What can be done to a Bot: pin and hide (the person's own list only), duplicate, reset what it
 * has with this person, and — for whoever may manage it — delete it.
 *
 * Navigation is the caller's: hiding and deleting leave the page, duplicating opens the copy.
 */
export function ManageSection({
  agent,
  onHidden,
  onDuplicated,
  onDeleted,
}: {
  agent: AgentProfile;
  onHidden: () => void;
  onDuplicated: (copyId: string) => void;
  onDeleted: () => void;
}) {
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const error = setPinned.error ?? setHidden.error ?? duplicate.error;
  // An administrator put it in this person's list; it stays pinned and cannot be hidden.
  const assigned = agent.assignedToMe === true;

  return (
    <PageSection title="Manage">
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPin />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Pinned</ItemTitle>
            <ItemDescription>
              {assigned
                ? "Assigned to you by an administrator, so it stays at the top of your Bots list."
                : agent.pinned
                  ? "At the top of your Bots list. Nobody else's list changes."
                  : "Keep it at the top of your Bots list. Nobody else's list changes."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="Pinned"
              checked={agent.pinned || assigned}
              disabled={assigned || setPinned.isPending}
              onCheckedChange={(pinned) =>
                setPinned.mutate({ agentId: agent.id, pinned })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconEyeOff />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Hidden</ItemTitle>
            <ItemDescription>
              {assigned
                ? "Assigned to you by an administrator, so it cannot be hidden."
                : agent.hidden
                  ? "Folded under Hidden on your Bots list. Nobody else's list changes."
                  : "Take it off your Bots list. Nobody else's list changes."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="Hidden"
              checked={agent.hidden}
              disabled={assigned || setHidden.isPending}
              onCheckedChange={async (hidden) => {
                await setHidden.mutateAsync({ agentId: agent.id, hidden });
                if (hidden) onHidden();
              }}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={
            <button
              disabled={duplicate.isPending}
              onClick={async () =>
                onDuplicated((await duplicate.mutateAsync(agent.id)).id)
              }
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconCopy />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Duplicate</ItemTitle>
            <ItemDescription>
              A copy of your own, with no key and no conversations.
            </ItemDescription>
          </ItemContent>
        </Item>
        <Separator />
        <Item
          render={<button onClick={() => setResetOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconRefresh />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Reset</ItemTitle>
            <ItemDescription>
              Delete your conversations with it, what it remembers for you, and
              its scheduled work. You see what will go first.
            </ItemDescription>
          </ItemContent>
        </Item>
        {agent.canManage ? (
          <>
            <Separator />
            <Item
              render={
                <button onClick={() => setDeleteOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconTrash />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Delete</ItemTitle>
                <ItemDescription>
                  For everyone. This cannot be undone.
                </ItemDescription>
              </ItemContent>
            </Item>
          </>
        ) : null}
      </PageRows>
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {agent.name}?</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setDeleteOpen(false)}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={async () => {
                await remove.mutateAsync(agent.id);
                onDeleted();
              }}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
