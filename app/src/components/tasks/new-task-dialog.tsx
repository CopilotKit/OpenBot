import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { startTaskMutationOptions } from "@/lib/tasks/mutations";
import type { TaskRecord } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";

/** The longest ask the server takes (`POST /api/tasks`). */
export const INSTRUCTION_MAX = 4000;

/**
 * The + on Tasks: which Bot, and what it should do. Start opens it as a task in a conversation of
 * its own and starts its turn there, as a Bot handing work to a task from Chat would, and the task's
 * page opens. The Bot is the person's default one until they choose another.
 */
export function NewTaskDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (task: TaskRecord) => void;
}) {
  const formId = useId();
  const bots = useQuery(agentListQueryOptions());
  const [picked, setPicked] = useState("");
  const [instruction, setInstruction] = useState("");
  const start = useMutation(startTaskMutationOptions(queryClient));
  const botId = picked || defaultAgentProfile(bots.data)?.id || "";
  const ask = instruction.trim();
  const send = () => {
    if (!botId || !ask || start.isPending) return;
    start.mutate({ botId, instruction: ask }, { onSuccess: onStarted });
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && !start.isPending) onClose();
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            The Bot works on it in a conversation of its own. It shows up in
            Tasks, and you can reply to steer it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-bot`}>Bot</FieldLabel>
                <Select
                  disabled={start.isPending}
                  items={Object.fromEntries(
                    (bots.data ?? []).map((bot) => [bot.id, bot.name]),
                  )}
                  onValueChange={(value) => setPicked(value ?? "")}
                  required
                  value={botId || null}
                >
                  <SelectTrigger className="w-full" id={`${formId}-bot`}>
                    <SelectValue placeholder="Choose a Bot" />
                  </SelectTrigger>
                  <SelectContent>
                    {(bots.data ?? []).map((bot) => (
                      <SelectItem key={bot.id} value={bot.id}>
                        {bot.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-instruction`}>
                  What should it do?
                </FieldLabel>
                <Textarea
                  autoFocus
                  className="min-h-28"
                  disabled={start.isPending}
                  id={`${formId}-instruction`}
                  maxLength={INSTRUCTION_MAX}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    // ⌘ or Ctrl with Enter starts it, as the composer sends.
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Draft a reply, find a time, look something up…"
                  required
                  value={instruction}
                />
              </Field>
            </FieldGroup>
          </form>
          {bots.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              Couldn't load your Bots. Reload the page.
            </p>
          ) : null}
          {start.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {start.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={start.isPending}
            onClick={onClose}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={start.isPending || !botId || !ask}
            form={formId}
            size="sm"
            type="submit"
          >
            {start.isPending ? "Starting…" : "Start task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
