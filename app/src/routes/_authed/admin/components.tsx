import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PreviewOf } from "@/components/gallery/preview";
import { StaggerItem } from "@/components/layout/stagger";
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
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ComponentRecord,
  componentKeys,
  componentListQueryOptions,
  type DataFunctionSummary,
  dataFunctionsQueryOptions,
} from "@/lib/components/queries";
import { RENDERABLE_NAMES } from "@/lib/copilot/gallery-registry";

/**
 * Runtime governance for compiled gallery components: publication, per-Bot grants, model-facing
 * descriptions, and component data-function access.
 */
export const Route = createFileRoute("/_authed/admin/components")({
  component: RouteComponent,
});

function RouteComponent() {
  const queryClient = useQueryClient();
  const { data: components, isLoading } = useQuery(componentListQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: dataFunctions } = useQuery(dataFunctionsQueryOptions());

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: componentKeys.all });
  };

  const setGrant = useMutation({
    mutationFn: async ({
      name,
      agentId,
      granted,
    }: {
      name: string;
      agentId: string;
      granted: boolean;
    }) => {
      const response = granted
        ? await fetch(`/api/components/${encodeURIComponent(name)}/grants`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId }),
          })
        : await fetch(
            `/api/components/${encodeURIComponent(name)}/grants/${encodeURIComponent(agentId)}`,
            { method: "DELETE", credentials: "include" },
          );
      if (!response.ok) throw new Error("That change could not be saved.");
    },
    onSuccess: invalidate,
  });

  const setFunction = useMutation({
    mutationFn: async ({
      name,
      functionName,
      granted,
    }: {
      name: string;
      functionName: string;
      granted: boolean;
    }) => {
      const response = granted
        ? await fetch(`/api/components/${encodeURIComponent(name)}/functions`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ function: functionName }),
          })
        : await fetch(
            `/api/components/${encodeURIComponent(name)}/functions/${encodeURIComponent(functionName)}`,
            { method: "DELETE", credentials: "include" },
          );
      if (!response.ok) throw new Error("That change could not be saved.");
    },
    onSuccess: invalidate,
  });

  const setPublished = useMutation({
    mutationFn: async ({
      name,
      published,
    }: {
      name: string;
      published: boolean;
    }) => {
      const response = await fetch(
        `/api/components/${encodeURIComponent(name)}/publication`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ published }),
        },
      );
      if (!response.ok) throw new Error("That change could not be saved.");
    },
    onSuccess: invalidate,
  });

  const saveDraft = useMutation({
    mutationFn: async ({
      name,
      description,
    }: {
      name: string;
      description: string;
    }) => {
      const response = await fetch(
        `/api/components/${encodeURIComponent(name)}/draft`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description }),
        },
      );
      if (!response.ok) throw new Error("That draft could not be saved.");
    },
    onSuccess: invalidate,
  });

  const bots = agents ?? [];

  return (
    <PageShell
      description="What each Bot may answer with. Every published component is available to every Bot; switch one off here and that Bot is never told about it. Each change and each refusal is a row in Audit."
      title="Components"
    >
      {/*
       * ONE CARD EACH, RATHER THAN A ROW EACH. Every other list in admin is `Item` rows, and these
       * started as hand-drawn ones — but a component carries per-Bot grants and per-function grants,
       * which is a set of switches rather than a line of text. Cramming that into a row would mean
       * hiding it behind a menu, and which Bots hold a component is the thing this page exists to
       * answer at a glance.
       */}
      <PageSection title="Published components">
        {isLoading ? <PageEmpty>Loading…</PageEmpty> : null}

        {components?.length === 0 && !isLoading ? (
          <PageEmpty>This deployment ships no components.</PageEmpty>
        ) : null}

        <div className="mt-4 flex flex-col gap-3">
          {(components ?? []).map((component, index) => (
            <StaggerItem index={index} key={component.name}>
              <ComponentRow
                bots={bots}
                component={component}
                dataFunctions={dataFunctions ?? []}
                key={component.name}
                onSetFunction={(functionName, granted) =>
                  setFunction.mutate({
                    functionName,
                    granted,
                    name: component.name,
                  })
                }
                onPublish={(published) =>
                  setPublished.mutate({ name: component.name, published })
                }
                onSaveDraft={(description) =>
                  saveDraft.mutate({ name: component.name, description })
                }
                onSetGrant={(agentId, granted) =>
                  setGrant.mutate({ agentId, granted, name: component.name })
                }
              />
            </StaggerItem>
          ))}
        </div>
      </PageSection>
    </PageShell>
  );
}

function ComponentRow({
  component,
  bots,
  dataFunctions,
  onSetGrant,
  onSetFunction,
  onPublish,
  onSaveDraft,
}: {
  component: ComponentRecord;
  bots: { id: string; name: string }[];
  dataFunctions: DataFunctionSummary[];
  onSetGrant: (agentId: string, granted: boolean) => void;
  onSetFunction: (functionName: string, granted: boolean) => void;
  onPublish: (published: boolean) => void;
  onSaveDraft: (description: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(component.draftDescription);
  const withheld = new Set(component.withheldFrom);
  const heldFunctions = new Set(component.functions);

  return (
    <section
      className="rounded-lg border border-border bg-card"
      data-testid={`component-${component.name}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">{component.title}</h3>
            <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-muted-foreground">
              {component.name}
            </code>
            {RENDERABLE_NAMES.has(component.name) ? null : (
              <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                Not in this build, nothing can draw it
              </span>
            )}
            {component.published ? null : (
              <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                Unpublished, no Bot may use it
              </span>
            )}
            {component.hasUnpublishedChanges ? (
              <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                Draft not published
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {component.publishedDescription ??
              "Nothing is published, so no Bot is told about this."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Last changed {new Date(component.updatedAt).toLocaleString()}
            {component.updatedBy ? ` by ${component.updatedBy}` : null}
          </p>
          {/*
           * What granting this actually puts in front of somebody.
           *
           * Closed by default: this page is a list an administrator scans, and thirteen components
           * drawn at once is a page nobody reads. Open, it is the real component, which is the only
           * thing that answers "should this Bot have it".
           */}
          {RENDERABLE_NAMES.has(component.name) ? (
            <details className="mt-3 max-w-3xl">
              <summary className="cursor-pointer text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground">
                See it
              </summary>
              <div className="mt-3">
                <PreviewOf name={component.name} />
              </div>
            </details>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={() => setEditing((open) => !open)}
            size="sm"
            variant="outline"
          >
            Edit description
          </Button>
          <Button
            data-testid={`publish-${component.name}`}
            onClick={() => onPublish(!component.published)}
            size="sm"
            variant={component.published ? "outline" : "default"}
          >
            {component.published ? "Unpublish" : "Publish"}
          </Button>
        </div>
      </div>

      <Dialog onOpenChange={setEditing} open={editing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{component.title}</DialogTitle>
            <DialogDescription>
              The draft description is what the model reads when deciding to
              call this. It changes nothing until it is published.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Field>
              <FieldLabel htmlFor={`draft-${component.name}`}>
                Draft description
              </FieldLabel>
              <Textarea
                id={`draft-${component.name}`}
                onChange={(event) => setDraft(event.target.value)}
                rows={4}
                value={draft}
              />
            </Field>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setEditing(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              onClick={() => {
                onSaveDraft(draft);
                setEditing(false);
              }}
              size="sm"
              variant="outline"
            >
              Save draft
            </Button>
            <Button
              onClick={() => {
                onSaveDraft(draft);
                onPublish(true);
                setEditing(false);
              }}
              size="sm"
            >
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap gap-2 px-4 py-3">
        {bots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There are no Bots yet.
          </p>
        ) : null}
        {bots.map((bot) => {
          const has = !withheld.has(bot.id);
          return (
            <Button
              data-testid={`grant-${component.name}-${bot.id}`}
              key={bot.id}
              onClick={() => onSetGrant(bot.id, !has)}
              size="sm"
              type="button"
              /* The fill is the state, as on the skills grants: a glance has to answer which are on. */
              variant={has ? "default" : "outline"}
            >
              {bot.name}
            </Button>
          );
        })}
      </div>

      {/* Data-function grants are separate from Bot component grants. */}
      {dataFunctions.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">May read</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {dataFunctions.map((fn) => {
              const has = heldFunctions.has(fn.name);
              return (
                <Button
                  data-testid={`function-${component.name}-${fn.name}`}
                  key={fn.name}
                  onClick={() => onSetFunction(fn.name, !has)}
                  size="sm"
                  title={fn.description}
                  type="button"
                  variant={has ? "default" : "outline"}
                >
                  {fn.name}
                  <span className="ml-2 text-muted-foreground text-xs">
                    {fn.reads}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
