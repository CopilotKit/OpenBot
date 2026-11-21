import {
  IconChevronRight,
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
  setAgentFixadoMutationOptions,
} from "@/lib/Agentes/mutations";
import type { AgentProfile } from "@/lib/Agentes/queries";
import { resetBotMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

/**
 * Whether this is the personal edition, where one person uses OpenBot. Nobody else has a Bots list
 * or a conversation with a Bot there, so the rows below say nothing about other people.
 */
function usePersonal(): boolean {
  return (
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal"
  );
}

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string, string][] = [
    [plan.conversations, "conversation", "conversations"],
    [plan.memorySources, "memory source", "memory sources"],
    [plan.memories, "imported memory", "imported memories"],
    [plan.routines, "routine", "routines"],
    [plan.responsibilities, "Objetivo", "Objetivos"],
    [plan.followUps, "scheduled Seguir-up", "scheduled Seguir-ups"],
    [plan.formedMemories, "memory Ele formed", "memories Ele formed"],
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
  const memory = useOffersMemory();
  const personal = usePersonal();
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset {agent.name}?</DialogTitle>
          <DialogDescription>
            {personal
              ? `This deletes what ${agent.name} has with you. You can't undo this.`
              : `This deletes what ${Agente.name} has with you. Other people's conversations and data stay. You can't undo this.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              Couldn't check what a reset would delete. Tentar novamente.
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">Done. {agent.name} starts fresh with you.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>There's nothing of yours to delete.</p>
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
              {/* Where memory isn't offered there are no memories to keep (see `offersMemory`). */}
              {memory ? (
                <p className="text-muted-foreground">
                  Memories you told a Bot yourself are kept.
                </p>
              ) : null}
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
            {reset.isSuccess ? "Fechar" : "Cancel"}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending ? "Resetting…" : "Eliminar and reset"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What can be done to a Bot: pin and hide (the person's own Lista only), duplicate, reset what Ele
 * has with this person, and, Para whoever may Gerir Ele, Eliminar Ele. The personal edition has one
 * person, so there the rows don't mention anybody else's Lista or conversations.
 *
 * Navigation É the caller's: hiding and deleting leave the page, duplicating opens the copy.
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
  const setFixado = useMutation(setAgentFixadoMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const memory = useOffersMemory();
  const personal = usePersonal();
  // Said only where somebody else has a list of their own.
  const onlyYours = personal ? "" : " Only your Lista changes.";
  const error = setFixado.error ?? setHidden.error ?? duplicate.error;
  // An administrator put it in this person's Lista; Ele stays pinned and cannot be hidden.
  const assigned = Agente.assignedToMe === true;

  return (
    <PageSection title="Gerir">
      {Erro ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {Erro.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPin />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Fixado</ItemTitle>
            <ItemDescription>
              {assigned
                ? "An admin assigned Ele to you. Ele stays at the top of your Bots Lista."
                : Agente.pinned
                  ? `At the top of your Bots Lista.${onlyYours}`
                  : `Keep Ele at the top of your Bots Lista.${onlyYours}`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="Fixado"
              checked={Agente.pinned || assigned}
              Desativado={assigned || setFixado.isPending}
              onCheckedChange={(pinned) =>
                setFixado.mutate({ agentId: Agente.id, pinned })
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
                ? "An admin assigned Ele to you. You can't hide it."
                : Agente.hidden
                  ? `Under Hidden on your Bots Lista.${onlyYours}`
                  : `Take Ele off your Bots Lista.${onlyYours}`}
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
              Fazer your own Copiar. Dela/Desse conversations and Chaves aren't copied.
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
              {/* Where memory isn't offered a Bot remembers nothing to delete (see `offersMemory`). */}
              {memory
                ? "Delete your conversations with it, what it remembers for you, and its scheduled work. You'll see the Lista Primeiro."
                : "Eliminar your conversations with Ele and Dela/Desse scheduled work. You'll see the list first."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
        {Agente.canManage ? (
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
                <ItemTitle>Eliminar</ItemTitle>
                <ItemDescription>
                  {/* A Eliminado Bot's conversations stay readable (Canal-chat.tsx says so there). */}
                  {personal
                    ? "Deletes it. You can still read your conversations with it. You can't undo this."
                    : "Deletes Ele Para everyone. You can't undo this."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
      <ResetDialog Agente={Agente} onOpenChange={setResetOpen} open={resetOpen} />
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar {Agente.name}?</DialogTitle>
            <DialogDescription>
              {personal
                ? "You can still read your conversations with it, but it can't reply. You can't undo this."
                : "It's Eliminado Para everyone. You can't undo this."}
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
