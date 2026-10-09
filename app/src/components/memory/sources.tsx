import { IconPlugConnected, IconPlus } from "@tabler/icons-react";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  addMemorySource,
  availableMemorySourcesQueryOptions,
  memoryKeys,
  memorySourceAction,
  memorySourcesQueryOptions,
} from "@/lib/memory";
import { queryClient } from "@/query-client";

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: memoryKeys.all });
}
/**
 * Connected apps a Bot reads facts from. Given a Bot, only that Bot's sources, and a new one is that
 * Bot's without asking.
 *
 * Each source is a row; adding one is a dialog behind the section's action. The draft lives here
 * rather than in the dialog, so the Bot's read actions are already loaded when it opens.
 */
export function MemorySources({ agentId: fixedBot }: { agentId?: string }) {
  const sources = useQuery(memorySourcesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [adding, setAdding] = useState(false);
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
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
      setAdding(false);
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
  const shown = (sources.data ?? []).filter(
    (source) => fixedBot === undefined || source.agentId === fixedBot,
  );
  return (
    <PageSection
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          Add source
        </Button>
      }
      description="Opt in to a read from an app this Bot can already access. Enabled sources refresh every 15 minutes, and their facts are available to this Bot only."
      title="Connected app sources"
    >
      {sources.isPending ? null : sources.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {sources.error.message}
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty>No connected app sources yet.</PageEmpty>
      ) : (
        <PageRows>
          {shown.map((source, index) => (
            <Fragment key={source.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlugConnected />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{source.title}</ItemTitle>
                  <ItemDescription>
                    {source.enabled
                      ? source.syncStatus === "succeeded"
                        ? "Up to date"
                        : source.syncStatus
                      : "Disabled"}
                    {source.lastSyncAt
                      ? ` · Last read ${new Date(source.lastSyncAt).toLocaleString()}`
                      : ""}
                  </ItemDescription>
                  {source.syncError && (
                    <p role="alert" className="text-destructive text-sm">
                      {source.syncError}
                    </p>
                  )}
                  {/* A set, so it wraps onto its own line rather than crowding the title. */}
                  <ItemFooter>
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
                          action.mutate({ sourceId: source.id, name: "remove" })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </ItemFooter>
                </ItemContent>
                <ItemActions>
                  {/* Binary and immediate: it refreshes, or stops refreshing, when switched. */}
                  <Switch
                    aria-label={`Read ${source.title}`}
                    checked={source.enabled}
                    disabled={action.isPending}
                    onCheckedChange={(enabled) =>
                      action.mutate({
                        sourceId: source.id,
                        name: enabled ? "enable" : "disable",
                      })
                    }
                  />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {action.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {action.error.message}
        </p>
      )}
      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a source</DialogTitle>
            <DialogDescription>
              It is read now, and then every 15 minutes while it is enabled.
            </DialogDescription>
          </DialogHeader>
          {/*
           * `contents`, so the body is still DialogContent's own flex child and keeps its
           * `flex-1 min-h-0` chain, while the submit in the footer stays inside the form.
           */}
          <form
            className="contents"
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
            <DialogBody className="mt-4 overflow-y-auto">
              <FieldGroup>
                {fixedBot === undefined ? (
                  <Field>
                    <FieldLabel htmlFor={`${id}-bot`}>Bot</FieldLabel>
                    <Select
                      items={bots.data?.map((bot) => ({
                        value: bot.id,
                        label: bot.name,
                      }))}
                      onValueChange={(value) => {
                        setAgentId(value ?? "");
                        setToolRef("");
                      }}
                      required
                      value={agentId || null}
                    >
                      <SelectTrigger className="w-full" id={`${id}-bot`}>
                        <SelectValue placeholder="Choose a Bot" />
                      </SelectTrigger>
                      <SelectContent>
                        {bots.data?.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor={`${id}-action`}>
                    Connected app action
                  </FieldLabel>
                  <Select
                    items={tools.data?.map((tool) => ({
                      value: tool.ref,
                      label: tool.title,
                    }))}
                    onValueChange={(value) => {
                      setToolRef(value ?? "");
                      setArgs({});
                    }}
                    required
                    value={toolRef || null}
                  >
                    <SelectTrigger className="w-full" id={`${id}-action`}>
                      <SelectValue placeholder="Choose a read action" />
                    </SelectTrigger>
                    <SelectContent>
                      {tools.data?.map((tool) => (
                        <SelectItem key={tool.ref} value={tool.ref}>
                          {tool.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {chosen?.description ? (
                    <FieldDescription>{chosen.description}</FieldDescription>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-name`}>Source name</FieldLabel>
                  <Input
                    id={`${id}-name`}
                    required
                    maxLength={160}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="My project documents"
                  />
                </Field>
                {settings.map(({ name, schema }) => (
                  <Field key={name}>
                    <FieldLabel htmlFor={`${id}-${name}`}>
                      {schema.title || name.replaceAll("_", " ")}
                      {required.includes(name) ? " *" : ""}
                    </FieldLabel>
                    {schema.type === "boolean" || schema.enum ? (
                      <Select
                        onValueChange={(value) =>
                          setArgs({ ...args, [name]: value ?? "" })
                        }
                        required={required.includes(name)}
                        value={args[name] || null}
                      >
                        <SelectTrigger className="w-full" id={`${id}-${name}`}>
                          <SelectValue placeholder="Choose a value" />
                        </SelectTrigger>
                        <SelectContent>
                          {(schema.enum ?? ["true", "false"]).map((value) => (
                            <SelectItem
                              key={String(value)}
                              value={String(value)}
                            >
                              {String(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                      <FieldDescription>{schema.description}</FieldDescription>
                    )}
                  </Field>
                ))}
              </FieldGroup>
              {(error || add.error || tools.error) && (
                <p role="alert" className="text-destructive text-sm">
                  {error || add.error?.message || tools.error?.message}
                </p>
              )}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => setAdding(false)}
                size="sm"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={add.isPending || !toolRef}
                size="sm"
                type="submit"
              >
                {add.isPending ? "Reading source…" : "Add and sync source"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
