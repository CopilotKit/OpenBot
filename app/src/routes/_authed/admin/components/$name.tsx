import {
  IconAlertTriangle,
  IconChevronRight,
  IconClock,
  IconCode,
  IconDatabase,
  IconFileText,
  IconTag,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ComponentPreview } from "@/components/component-preview";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  saveComponentDraftMutationOptions,
  setComponentFunctionMutationOptions,
  setComponentGrantMutationOptions,
  setComponentPublishedMutationOptions,
} from "@/lib/components/mutations";
import {
  type ComponentRecord,
  componentListQueryOptions,
  type DataFunctionSummary,
  dataFunctionsQueryOptions,
} from "@/lib/components/queries";
import { RENDERABLE_NAMES } from "@/lib/copilot/gallery-registry";
import { queryClient } from "@/query-client";

/**
 * Governance for one compiled component: publication, per-Bot grants, the model-facing description,
 * and which data functions it may read.
 */
/** The same way back from every state this route can be in. */
const BACK = {
  label: "UI Components",
  linkProps: { to: "/admin/components" },
} as const;

export const Route = createFileRoute("/_authed/admin/components/$name")({
  component: RouteComponent,
});

function RouteComponent() {
  const { name } = Route.useParams();
  const components = useQuery(componentListQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const dataFunctions = useQuery(dataFunctionsQueryOptions());

  const setGrant = useMutation(setComponentGrantMutationOptions(queryClient));
  const setFunction = useMutation(
    setComponentFunctionMutationOptions(queryClient),
  );
  const setPublished = useMutation(
    setComponentPublishedMutationOptions(queryClient),
  );
  const saveDraft = useMutation(saveComponentDraftMutationOptions(queryClient));

  /*
   * Read out of the list rather than held in state, so a change made here is reflected here.
   */
  const component = components.data?.find((entry) => entry.name === name);

  /*
   * Pending first and drawing nothing: there is no loading placeholder in this app, and the
   * alternative here is worse than a blank — "no such component" while the list is still in flight
   * says something false about a component that is about to appear.
   */
  if (components.isPending) return null;

  if (components.error) {
    return (
      <PageShell backButton={BACK} title="Components">
        <p className="mt-8 text-destructive text-sm" role="alert">
          Could not load components.
        </p>
      </PageShell>
    );
  }

  if (!component) {
    /*
     * A name in the URL is a claim, not a promise: it can be stale, mistyped, or a component this
     * build no longer ships.
     */
    return (
      <PageShell
        backButton={BACK}
        description="Nothing here answers to that name."
        title="No such component"
      >
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{name}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              It may have been renamed, or this deployment may no longer ship
              it.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            render={<Link to="/admin/components" />}
            size="sm"
            variant="outline"
          >
            Back to components
          </Button>
        </Empty>
      </PageShell>
    );
  }

  return (
    /*
     * Keyed on the name so the draft is seeded from the component actually being looked at. The
     * route component is reused when only the parameter changes, so without it the text held from
     * the last one opened would be what a save wrote back.
     */
    <ComponentDetail
      bots={agents.data ?? []}
      component={component}
      dataFunctions={dataFunctions.data ?? []}
      key={component.name}
      onPublish={(published) => setPublished.mutate({ name, published })}
      onSaveDraft={(description) => saveDraft.mutate({ description, name })}
      onSetFunction={(functionName, granted) =>
        setFunction.mutate({ functionName, granted, name })
      }
      onSetGrant={(agentId, granted) =>
        setGrant.mutate({ agentId, granted, name })
      }
    />
  );
}

/** Which sub-dialog is open, if any. */
type Sheet = "description" | "grants" | "functions" | null;

/**
 * A row that states something and cannot be changed. No chevron, because there is nothing behind it.
 */
function FactRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      <ItemActions className="text-muted-foreground text-sm">
        {children}
      </ItemActions>
    </Item>
  );
}

/**
 * A row whose detail is a dialog. The whole row is the button, as it is in the settings screens this
 * follows — a chevron on the right announces where it goes, but it is not the only thing you can hit.
 */
function SheetRow({
  icon,
  label,
  summary,
  onOpen,
  testId,
}: {
  icon: ReactNode;
  label: string;
  summary: string;
  onOpen: () => void;
  testId: string;
}) {
  return (
    <Item
      className="w-full text-left transition-colors hover:bg-muted/50"
      /*
       * No children on the render element. `useRender` merges props, and children given here would
       * replace the row's own — which is how this first drew as three empty rows. The button takes
       * its accessible name from the title and summary inside instead.
       */
      render={<button data-testid={testId} onClick={onOpen} type="button" />}
      size="sm"
    >
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * One component in full: what it is, what it looks like, what the model is told about it, and who
 * may use it.
 *
 * Settings-screen shape rather than a form. Each row states where something stands and, if it can be
 * changed, opens a dialog to change it; nothing is saved by a button at the bottom of the page,
 * because there is no page-level state to save. Publication and the grants take effect as they are
 * switched, and the description is the one thing held while it is being typed — which is why it is
 * the only dialog with a Cancel.
 */
function ComponentDetail({
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
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState(component.draftDescription);
  const withheld = new Set(component.withheldFrom);
  const heldFunctions = new Set(component.functions);
  const renderable = RENDERABLE_NAMES.has(component.name);

  const granted = bots.filter((bot) => !withheld.has(bot.id));
  const held = dataFunctions.filter((fn) => heldFunctions.has(fn.name));

  const grantSummary =
    bots.length === 0
      ? "There are no Bots yet"
      : granted.length === bots.length
        ? `All ${bots.length} Bots`
        : granted.length === 0
          ? "No Bots"
          : `${granted.length} of ${bots.length} Bots`;

  const functionSummary =
    dataFunctions.length === 0
      ? "This deployment grants no data functions"
      : held.length === 0
        ? "Nothing — it draws only what the model hands it"
        : held.map((fn) => fn.name).join(", ");

  return (
    <PageShell
      backButton={BACK}
      description={
        component.publishedDescription ??
        "Nothing is published, so no Bot is told about this."
      }
      title={component.title}
    >
      {/*
       * The render at the top of the page. Bordered and rounded rather than bleeding to the edges:
       * inside a prose column that is what the tiles do, and a page has no dialog edge to reach for.
       */}
      <div className="relative mt-8 aspect-[2/1] overflow-hidden rounded-lg border border-border bg-card">
        <div className="absolute inset-0">
          <SettingsItemBackground className="h-full w-full" />
        </div>
        <div className="absolute inset-0 z-10">
          <ComponentPreview name={component.name} />
        </div>
      </div>

      <PageSection
        description="What this component is for, and which Bots are allowed to answer with it."
        title="Configuration"
      >
        <PageRows>
          {/*
           * First, and only when it applies: a component this build cannot draw is a fact that
           * outranks everything under it, because none of it can have any effect.
           */}
          {renderable ? null : (
            <>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconAlertTriangle className="text-amber-600 dark:text-amber-400" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Not in this build</ItemTitle>
                  <ItemDescription>
                    Nothing here can draw it, whatever else is set.
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
            </>
          )}

          <Item size="sm">
            <ItemMedia variant="icon">
              <IconWorld />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Published</ItemTitle>
              <ItemDescription>
                {component.published
                  ? "Bots may answer with it."
                  : "No Bot may use it."}
                {component.hasUnpublishedChanges
                  ? " The description has changes that are not published."
                  : null}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Published"
                checked={component.published}
                data-testid={`publish-${component.name}`}
                onCheckedChange={onPublish}
              />
            </ItemActions>
          </Item>

          <Separator />

          <SheetRow
            icon={<IconFileText />}
            label="Description"
            onOpen={() => setSheet("description")}
            summary={component.draftDescription || "Nothing yet"}
            testId={`description-${component.name}`}
          />

          <Separator />

          <SheetRow
            icon={<IconUsers />}
            label="Available to"
            onOpen={() => setSheet("grants")}
            summary={grantSummary}
            testId={`grants-${component.name}`}
          />

          <Separator />

          <SheetRow
            icon={<IconDatabase />}
            label="May read"
            onOpen={() => setSheet("functions")}
            summary={functionSummary}
            testId={`functions-${component.name}`}
          />
        </PageRows>
      </PageSection>

      <PageSection title="Details">
        <PageRows>
          <FactRow icon={<IconTag />} label="Kind">
            {component.kind}
          </FactRow>
          <Separator />
          <FactRow icon={<IconCode />} label="Called as">
            <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs">
              {component.name}
            </code>
          </FactRow>
          <Separator />
          <FactRow icon={<IconClock />} label="Last changed">
            {new Date(component.updatedAt).toLocaleString()}
            {component.updatedBy ? ` by ${component.updatedBy}` : null}
          </FactRow>
        </PageRows>
      </PageSection>

      {/*
       * The one dialog holding state of its own, so the one with something to discard. The draft is
       * reset on close either way, so reopening reads what is actually stored rather than what was
       * abandoned.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setSheet(null);
            setDraft(component.draftDescription);
          }
        }}
        open={sheet === "description"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Description</DialogTitle>
            <DialogDescription>
              What the model reads when deciding to call this. It changes
              nothing until the component is published.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Textarea
              aria-label="Description"
              onChange={(event) => setDraft(event.target.value)}
              rows={6}
              value={draft}
            />
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => {
                setSheet(null);
                setDraft(component.draftDescription);
              }}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                onSaveDraft(draft);
                setSheet(null);
              }}
              size="sm"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Grants take effect as they are switched, so there is nothing here to save or to discard. */}
      <Dialog
        onOpenChange={(open) => !open && setSheet(null)}
        open={sheet === "grants"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Available to</DialogTitle>
            <DialogDescription>
              Switch a Bot off and it is never told this component exists, so it
              cannot ask for it and does not apologise for not having it. Each
              change takes effect immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {bots.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                There are no Bots yet.
              </p>
            ) : (
              <div className="flex flex-col">
                {bots.map((bot, index) => {
                  const has = !withheld.has(bot.id);
                  return (
                    <div key={bot.id}>
                      {index === 0 ? null : <Separator />}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{bot.name}</ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          <Switch
                            aria-label={bot.name}
                            checked={has}
                            data-testid={`grant-${component.name}-${bot.id}`}
                            onCheckedChange={(next) => onSetGrant(bot.id, next)}
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setSheet(null)} size="sm">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setSheet(null)}
        open={sheet === "functions"}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>May read</DialogTitle>
            <DialogDescription>
              A separate grant from Available to, and not implied by it: that
              one decides who may draw this, and this decides what it may go and
              fetch in order to draw itself. Until one of these is on it shows
              only what the Bot passes it, and every read it does make is a row
              in Audit. Each change takes effect immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {dataFunctions.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                This deployment grants no data functions.
              </p>
            ) : (
              <div className="flex flex-col">
                {dataFunctions.map((fn, index) => {
                  const has = heldFunctions.has(fn.name);
                  return (
                    <div key={fn.name}>
                      {index === 0 ? null : <Separator />}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{fn.name}</ItemTitle>
                          <ItemDescription>{fn.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Switch
                            aria-label={fn.name}
                            checked={has}
                            data-testid={`function-${component.name}-${fn.name}`}
                            onCheckedChange={(next) =>
                              onSetFunction(fn.name, next)
                            }
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setSheet(null)} size="sm">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
