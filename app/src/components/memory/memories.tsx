import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
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

/** A fact the person tells their Bots directly. It reaches every one of them. */
export function RememberFact() {
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  return (
    <PageSection title="Remember a fact">
      <form
        className="mt-4 grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          remember.mutate(content, { onSuccess: () => setContent("") });
        }}
      >
        <label className="grid min-w-0 gap-1 text-sm" htmlFor={formId}>
          Something you want your Bots to know
        </label>
        <Textarea
          id={formId}
          required
          maxLength={6000}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="I prefer meetings in the morning."
        />
        <Button
          type="submit"
          disabled={remember.isPending || !content.trim()}
          className="justify-self-start"
        >
          Remember
        </Button>
        {remember.error ? (
          <p role="alert" className="text-destructive">
            {remember.error.message}
          </p>
        ) : null}
      </form>
    </PageSection>
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
      <div className="mt-4 grid gap-3">
        {memories.isPending ? null : memories.error ? (
          <p role="alert" className="text-destructive text-sm">
            {memories.error.message}
          </p>
        ) : memories.data.length ? (
          memories.data.map((memory) => (
            <MemoryCard
              botName={botName(memory.formedByAgentId)}
              key={memory.id}
              memory={memory}
            />
          ))
        ) : (
          <p className="text-muted-foreground text-sm">
            You have no memories yet.
          </p>
        )}
      </div>
    </PageSection>
  );
}

function MemoryCard({
  memory,
  botName,
}: {
  memory: MemoryRecord;
  botName: string;
}) {
  const [content, setContent] = useState(memory.content);
  const id = useId();
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const update = (input: {
    content?: string;
    enabled?: boolean;
    reviewState?: "confirmed";
  }) => save.mutate({ id: memory.id, input });
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          {memory.provenance}
        </label>
        <span className="text-xs text-muted-foreground">
          {!memory.enabled
            ? "Disabled"
            : memory.formedBy === "bot"
              ? `Formed by ${botName}${memory.reviewState === "unreviewed" ? " · awaiting review" : ""}`
              : memory.reviewState === "unreviewed"
                ? "Imported · awaiting review"
                : "Reviewed"}
        </span>
      </div>
      {memory.formedBy === "bot" && (
        <p className="text-xs text-muted-foreground">
          From {memory.sourceApp ?? "a conversation"}
          {memory.observedAt
            ? `, read ${new Date(memory.observedAt).toLocaleString()}`
            : ""}
          {memory.sourceLink && (
            <>
              {" · "}
              <a
                className="underline"
                href={memory.sourceLink}
                target="_blank"
                rel="noreferrer"
              >
                Open record
              </a>
            </>
          )}
        </p>
      )}
      <Textarea
        id={id}
        value={content}
        maxLength={6000}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !content.trim()}
          onClick={() => update({ content })}
        >
          Save
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
          onClick={() => update({ enabled: !memory.enabled })}
        >
          {memory.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={forget.isPending}
          onClick={() => forget.mutate(memory.id)}
        >
          Forget
        </Button>
      </div>
      {(save.error || forget.error) && (
        <p role="alert" className="text-destructive">
          {save.error?.message || forget.error?.message}
        </p>
      )}
    </article>
  );
}
