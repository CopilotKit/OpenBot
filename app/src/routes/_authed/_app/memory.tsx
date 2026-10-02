import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  addMemorySource,
  availableMemorySourcesQueryOptions,
  createMemory,
  deleteMemory,
  type MemoryRecord,
  memoriesQueryOptions,
  memoryKeys,
  memorySourceAction,
  memorySourcesQueryOptions,
  updateMemory,
} from "@/lib/memory";
import { queryClient } from "@/query-client";
export const Route = createFileRoute("/_authed/_app/memory")({
  component: MemoryPage,
});
// min-w-0 and w-full, or a select as wide as its longest option pushes its grid column off the card.
const field = "grid min-w-0 gap-1 text-sm";
const select =
  "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: memoryKeys.all });
}
function MemoryPage() {
  const memories = useQuery(memoriesQueryOptions());
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation({
    mutationFn: createMemory,
    onSuccess: async () => {
      setContent("");
      await refresh();
    },
  });
  return (
    <PageShell
      title="Memory"
      description="Review what your Bots remember, and choose which connected apps can contribute facts."
    >
      <div className="grid gap-6">
        <SuggestionsInbox />
        <form
          className="grid gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            remember.mutate(content);
          }}
        >
          <h2 className="font-semibold">Remember a fact</h2>
          <label className={field} htmlFor={formId}>
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
          {remember.error && (
            <p role="alert" className="text-destructive">
              {remember.error.message}
            </p>
          )}
        </form>
        <ProactiveResearchSettings />
        <Sources />
        <section className="grid gap-3">
          <h2 className="font-semibold">Your memories</h2>
          {memories.isPending ? (
            <p>Loading memories…</p>
          ) : memories.error ? (
            <p role="alert" className="text-destructive">
              {memories.error.message}
            </p>
          ) : memories.data?.length ? (
            memories.data.map((memory) => (
              <MemoryCard key={memory.id} memory={memory} />
            ))
          ) : (
            <p className="text-muted-foreground">You have no memories yet.</p>
          )}
        </section>
      </div>
    </PageShell>
  );
}
function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const [content, setContent] = useState(memory.content);
  const id = useId();
  const save = useMutation({
    mutationFn: (input: {
      content?: string;
      enabled?: boolean;
      reviewState?: "confirmed";
    }) => updateMemory(memory.id, input),
    onSuccess: refresh,
  });
  const forget = useMutation({
    mutationFn: () => deleteMemory(memory.id),
    onSuccess: refresh,
  });
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          {memory.provenance}
        </label>
        <span className="text-xs text-muted-foreground">
          {!memory.enabled
            ? "Disabled"
            : memory.reviewState === "unreviewed"
              ? memory.formedBy === "bot"
                ? "Formed by your Bot · awaiting review"
                : "Imported · awaiting review"
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
          onClick={() => save.mutate({ content })}
        >
          Save
        </Button>
        {memory.reviewState === "unreviewed" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => save.mutate({ reviewState: "confirmed" })}
          >
            Confirm
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => save.mutate({ enabled: !memory.enabled })}
        >
          {memory.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={forget.isPending}
          onClick={() => forget.mutate()}
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
function Sources() {
  const sources = useQuery(memorySourcesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [agentId, setAgentId] = useState("");
  const [toolRef, setToolRef] = useState("");
  const [title, setTitle] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const id = useId();
  const tools = useQuery(availableMemorySourcesQueryOptions(agentId));
  const chosen = tools.data?.find((tool) => tool.ref === toolRef);
  const properties = chosen?.inputSchema.properties;
  const settings =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties).flatMap(([name, value]) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  name,
                  schema: value as {
                    type?: string;
                    title?: string;
                    description?: string;
                    enum?: unknown[];
                  },
                },
              ]
            : [],
        )
      : [];
  const required = Array.isArray(chosen?.inputSchema.required)
    ? chosen.inputSchema.required
    : [];
  const add = useMutation({
    mutationFn: addMemorySource,
    onSuccess: async () => {
      setTitle("");
      await refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({
      sourceId,
      name,
    }: {
      sourceId: string;
      name: "sync" | "remove" | "enable" | "disable";
    }) => memorySourceAction(sourceId, name),
    onSuccess: refresh,
  });
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">Connected app sources</h2>
      <p className="text-sm text-muted-foreground">
        Opt in to a read from an app your Bot can already access. Enabled
        sources refresh every 15 minutes. Their facts are available to the
        selected Bot.
      </p>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const values: Record<string, unknown> = {};
            for (const setting of settings) {
              const value = args[setting.name];
              if (!value) continue;
              if (
                setting.schema.type === "number" ||
                setting.schema.type === "integer"
              ) {
                const number = Number(value);
                if (!Number.isFinite(number))
                  throw new Error(`Enter a number for ${setting.name}.`);
                values[setting.name] = number;
              } else if (setting.schema.type === "boolean")
                values[setting.name] = value === "true";
              else if (setting.schema.type === "array")
                values[setting.name] = value
                  .split("\n")
                  .map((entry) => entry.trim())
                  .filter(Boolean);
              else if (setting.schema.type === "object")
                throw new Error(
                  "Choose an action with simple search settings.",
                );
              else values[setting.name] = value;
            }
            setError("");
            add.mutate({
              agentId,
              toolRef,
              title,
              args: values,
            });
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Check the source settings.",
            );
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            Bot
            <select
              required
              className={select}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setToolRef("");
              }}
            >
              <option value="">Choose a Bot</option>
              {bots.data?.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            Connected app action
            <select
              required
              className={select}
              value={toolRef}
              onChange={(event) => {
                setToolRef(event.target.value);
                setArgs({});
              }}
            >
              <option value="">Choose a read action</option>
              {tools.data?.map((tool) => (
                <option key={tool.ref} value={tool.ref}>
                  {tool.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {chosen && (
          <p className="text-sm text-muted-foreground">{chosen.description}</p>
        )}
        <label className={field} htmlFor={`${id}-name`}>
          Source name
          <Input
            id={`${id}-name`}
            required
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="My project documents"
          />
        </label>
        {settings.map(({ name, schema }) => (
          <label key={name} className={field} htmlFor={`${id}-${name}`}>
            {schema.title || name.replaceAll("_", " ")}
            {required.includes(name) ? " *" : ""}
            {schema.type === "boolean" || schema.enum ? (
              <select
                id={`${id}-${name}`}
                className={select}
                value={args[name] ?? ""}
                required={required.includes(name)}
                onChange={(event) =>
                  setArgs({ ...args, [name]: event.target.value })
                }
              >
                <option value="">Choose a value</option>
                {(schema.enum ?? ["true", "false"]).map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {String(value)}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`${id}-${name}`}
                type={
                  schema.type === "number" || schema.type === "integer"
                    ? "number"
                    : "text"
                }
                required={required.includes(name)}
                value={args[name] ?? ""}
                onChange={(event) =>
                  setArgs({ ...args, [name]: event.target.value })
                }
              />
            )}
            {schema.description && (
              <span className="text-xs text-muted-foreground">
                {schema.description}
              </span>
            )}
          </label>
        ))}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={add.isPending || !toolRef}
        >
          {add.isPending ? "Reading source…" : "Add and sync source"}
        </Button>
        {(error || add.error || tools.error) && (
          <p role="alert" className="text-destructive">
            {error || add.error?.message || tools.error?.message}
          </p>
        )}
      </form>
      {sources.error && (
        <p role="alert" className="text-destructive">
          {sources.error.message}
        </p>
      )}
      {sources.data?.map((source) => (
        <article key={source.id} className="grid gap-2 rounded-lg border p-4">
          <div className="flex justify-between">
            <strong>{source.title}</strong>
            <span className="text-sm text-muted-foreground">
              {source.enabled
                ? source.syncStatus === "succeeded"
                  ? "Up to date"
                  : source.syncStatus
                : "Disabled"}
            </span>
          </div>
          {source.lastSyncAt && (
            <p className="text-xs text-muted-foreground">
              Last read {new Date(source.lastSyncAt).toLocaleString()}
            </p>
          )}
          {source.syncError && (
            <p role="alert" className="text-destructive">
              {source.syncError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!source.enabled || action.isPending}
              onClick={() =>
                action.mutate({ sourceId: source.id, name: "sync" })
              }
            >
              Sync now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate({
                  sourceId: source.id,
                  name: source.enabled ? "disable" : "enable",
                })
              }
            >
              {source.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate({ sourceId: source.id, name: "remove" })
              }
            >
              Remove
            </Button>
          </div>
        </article>
      ))}
      {action.error && (
        <p role="alert" className="text-destructive">
          {action.error.message}
        </p>
      )}
    </section>
  );
}
