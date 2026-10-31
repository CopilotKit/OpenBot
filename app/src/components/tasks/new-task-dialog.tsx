import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { formatHotkey } from "@/lib/hotkeys/hotkeys";
import { newId } from "@/lib/new-id";
import { startTaskMutationOptions } from "@/lib/tasks/mutations";
import type { TaskRecord } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";

/** The longest ask the server takes (`POST /api/tasks`). */
export const INSTRUCTION_MAX = 4000;

/** What has been typed into New task, kept by whoever opens it so closing it loses nothing. */
export type TaskDraft = { botId: string; instruction: string };

export const EMPTY_DRAFT: TaskDraft = { botId: "", instruction: "" };

/** ⌘ or Ctrl, as this keyboard writes it, then Enter. */
const START_KEYS = `${formatHotkey({ key: "enter", mod: true })[0]} Enter`;

/** A Bot as the picker shows it: its face, then its name. */
function BotChoice({
  bot,
}: {
  bot: Pick<AgentProfile, "name" | "avatarSeed">;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* The name beside it says who it is, so the face isn't announced too. */}
      <AbstractAvatar
        decorative
        name={bot.name}
        seed={bot.avatarSeed}
        size={20}
      />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}

/**
 * The + on Tasks: which Bot, and what it should do. Start opens it as a task in a conversation of
 * its own and starts its turn there, as a Bot handing work to a task from Chat would, and the task's
 * page opens. The Bot is the person's default one until they choose another.
 *
 * What was typed is the caller's (`draft`), so Escape or a click outside closes the dialog and keeps
 * the ask for next time; Cancel is the way to throw it away. Each opening sends its own `clientId`
 * with every Start, so a Start pressed twice opens one task.
 */
export function NewTaskDialog({
  draft,
  onDraftChange,
  onCancel,
  onClose,
  onStarted,
}: {
  draft: TaskDraft;
  onDraftChange: (draft: TaskDraft) => void;
  /** Cancel: close, and throw the draft away. */
  onCancel: () => void;
  /** Escape or a click outside: close, and keep the draft. */
  onClose: () => void;
  onStarted: (task: TaskRecord) => void;
}) {
  const formId = useId();
  const bots = useQuery(agentListQueryOptions());
  const [clientId] = useState(newId);
  const start = useMutation(startTaskMutationOptions(queryClient));
  const botId = draft.botId || defaultAgentProfile(bots.data)?.id || "";
  const chosen = bots.data?.find((bot) => bot.id === botId);
  const ask = draft.instruction.trim();
  const send = () => {
    if (!botId || !ask || start.isPending) return;
    start.mutate(
      { botId, instruction: ask, clientId },
      { onSuccess: onStarted },
    );
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
                  onValueChange={(value) =>
                    onDraftChange({ ...draft, botId: value ?? "" })
                  }
                  required
                  value={botId || null}
                >
                  <SelectTrigger className="w-full" id={`${formId}-bot`}>
                    {chosen ? (
                      <SelectValue>
                        <BotChoice bot={chosen} />
                      </SelectValue>
                    ) : (
                      <SelectValue placeholder="Choose a Bot" />
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    {(bots.data ?? []).map((bot) => (
                      <SelectItem key={bot.id} value={bot.id}>
                        <BotChoice bot={bot} />
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
                  aria-describedby={`${formId}-keys`}
                  onChange={(event) =>
                    onDraftChange({ ...draft, instruction: event.target.value })
                  }
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
                  value={draft.instruction}
                />
                <FieldDescription id={`${formId}-keys`}>
                  Press {START_KEYS} to start it.
                </FieldDescription>
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
            onClick={onCancel}
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
