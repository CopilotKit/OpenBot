import { IconPlus, IconRobot, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createMemoryMutationOptions,
  deleteMemoryMutationOptions,
  type MemoryRecord,
  memoriesQueryOptions,
  updateMemoryMutationOptions,
} from "@/lib/memory";
import { queryClient } from "@/query-client";

/**
 * A fact the person tells their Bots directly. It reaches every one of them.
 *
 * The page's one primary verb, so it is a button for `PageShell`'s `action` that opens a dialog,
 * rather than a form standing above the list somebody came to read.
 */
export function RememberFact() {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  return (
    <>
      <Button
        onClick={() => {
          // Opening starts clean: no draft or failure left from an earlier attempt.
          setContent("");
          remember.reset();
          setOpen(true);
        }}
        size="sm"
        variant="ghost"
      >
        <IconPlus />
        Remember a fact
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remember a fact</DialogTitle>
            <DialogDescription>
              It reaches every one of your Bots.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                remember.mutate(content, {
                  onSuccess: () => {
                    setContent("");
                    setOpen(false);
                  },
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor={`${formId}-content`}>
                  Something you want your Bots to know
                </FieldLabel>
                <Textarea
                  id={`${formId}-content`}
                  required
                  maxLength={6000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="I prefer meetings in the morning."
                />
              </Field>
            </form>
            {remember.error ? (
              <p role="alert" className="text-destructive text-sm">
                {remember.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={remember.isPending || !content.trim()}
              form={formId}
              size="sm"
              type="submit"
            >
              Remember
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Everything the person's Bots remember about them, with who formed each memory. */
export function MemoryList() {
  const memories = useQuery(memoriesQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string | null) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? "your Bot";
  return (
    <PageSection title="Your memories">
      {memories.isPending ? null : memories.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {memories.error.message}
        </p>
      ) : memories.data.length ? (
        <PageRows>
          {memories.data.map((memory, index) => (
            <Fragment key={memory.id}>
              {index > 0 ? <Separator /> : null}
              <MemoryRow
                botName={botName(memory.formedByAgentId)}
                memory={memory}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty>You have no memories yet.</PageEmpty>
      )}
    </PageSection>
  );
}

/**
 * One memory: the fact itself, then where it came from. Whether Bots use it is a switch; editing
 * its words opens a dialog, and confirming or forgetting it are the buttons beneath.
 */
function MemoryRow({
  memory,
  botName,
}: {
  memory: MemoryRecord;
  botName: string;
}) {
  const [editing, setEditing] = useState(false);
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const update = (input: {
    content?: string;
    enabled?: boolean;
    reviewState?: "confirmed";
  }) => save.mutate({ id: memory.id, input });
  const status = !memory.enabled
    ? "Disabled"
    : memory.formedBy === "bot"
      ? `Formed by ${botName}${memory.reviewState === "unreviewed" ? " · awaiting review" : ""}`
      : memory.reviewState === "unreviewed"
        ? "Imported · awaiting review"
        : "Reviewed";
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {memory.formedBy === "bot" ? <IconRobot /> : <IconUser />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {memory.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {memory.provenance} · {status}
        </ItemDescription>
        {memory.formedBy === "bot" && (
          <ItemDescription className="line-clamp-none">
            From {memory.sourceApp ?? "a conversation"}
            {memory.observedAt
              ? `, read ${new Date(memory.observedAt).toLocaleString()}`
              : ""}
            {memory.sourceLink && (
              <>
                {" · "}
                <a href={memory.sourceLink} target="_blank" rel="noreferrer">
                  Open record
                </a>
              </>
            )}
          </ItemDescription>
        )}
        {/* A set, so it wraps onto its own line rather than crowding the fact. */}
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
              size="sm"
              variant="outline"
            >
              Edit
            </Button>
            {memory.reviewState === "unreviewed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => update({ reviewState: "confirmed" })}
              >
                Confirm
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={forget.isPending}
              onClick={() => forget.mutate(memory.id)}
            >
              Forget
            </Button>
          </div>
        </ItemFooter>
        {!editing && (save.error || forget.error) && (
          <p role="alert" className="text-destructive text-sm">
            {save.error?.message || forget.error?.message}
          </p>
        )}
      </ItemContent>
      <ItemActions>
        {/* Binary and immediate: Bots stop or start using it when switched. */}
        <Switch
          aria-label={`Use this memory: ${clip(memory.content)}`}
          checked={memory.enabled}
          disabled={save.isPending}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </ItemActions>
      {editing ? (
        <EditMemoryDialog
          memory={memory}
          onClose={() => setEditing(false)}
          onSave={(content) =>
            save.mutate(
              { id: memory.id, input: { content } },
              { onSuccess: () => setEditing(false) },
            )
          }
          error={save.error?.message ?? null}
          saving={save.isPending}
        />
      ) : null}
    </Item>
  );
}

/** A memory's words, cut short enough to name the switch beside them. */
function clip(content: string) {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The memory's words in a dialog. Saving rewrites them; the server records it as edited. */
function EditMemoryDialog({
  memory,
  saving,
  error,
  onSave,
  onClose,
}: {
  memory: MemoryRecord;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState(memory.content);
  const id = useId();
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit memory</DialogTitle>
          <DialogDescription>{memory.provenance}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Field>
            <FieldLabel className="sr-only" htmlFor={id}>
              Memory
            </FieldLabel>
            <Textarea
              autoFocus
              id={id}
              maxLength={6000}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              value={content}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={saving || !content.trim()}
            onClick={() => onSave(content)}
            size="sm"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
