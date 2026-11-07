import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ComponentPreview } from "@/components/component-preview";
import { PageShell } from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { componentListQueryOptions } from "@/lib/components/queries";
import { galleryComponent } from "@/lib/copilot/gallery-registry";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * What a Bot can draw, for the person it draws for.
 *
 * The same gallery an administrator governs, with none of the governing. Published components only:
 * an unpublished one is not something any Bot can put on screen, so listing it here would describe a
 * capability nobody has.
 *
 * Each card says what the component shows in the person's words, its `summary`. Not the published
 * description: that is written for the model, names other tools and says "deployment", and was shown
 * here until a person on the personal edition read "Show what this deployment has actually been
 * doing" under Activity report. A playground component has no words but the ones its admin
 * published, so it keeps those.
 */
export const Route = createFileRoute("/_authed/settings/components-gallery/")({
  component: RouteComponent,
});

/**
 * The intro and the empty state, by edition. The team edition has an admin who publishes components
 * and decides which Bot uses which. The personal edition has no Admin: every component is published
 * when OpenBot starts and every Bot can use all of them, so there is nothing to say an admin does.
 */
const WORDS = {
  team: {
    intro:
      "Browse components that Bots can display in conversations. An admin controls which components each Bot can use.",
    emptyTitle: "Nothing published yet",
    empty: "When an admin publishes a component, it will show up here.",
  },
  personal: {
    intro:
      "Browse the components your Bots can show in conversations. Every Bot can use all of them.",
    emptyTitle: "No components yet",
    empty:
      "Components show up here once OpenBot has loaded them. Reload the page if this stays empty.",
  },
} as const;

function RouteComponent() {
  const components = useQuery(componentListQueryOptions());
  // Until the edition is known, the team edition's words, as everywhere else that reads it.
  const edition =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition ?? "team";
  const words = WORDS[edition];
  const published = components.data?.filter((component) => component.published);

  return (
    <PageShell description={words.intro} title="Components gallery">
      {components.isPending ? null : components.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Couldn't load components. Reload the page.
        </p>
      ) : published?.length === 0 ? (
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{words.emptyTitle}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              {words.empty}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-12 grid w-full grid-cols-1 gap-4 md:grid-cols-2">
          {published?.map((component) => (
            /*
             * No status dot, unlike the Admin tiles. Everything listed here is published by
             * definition, so a dot saying so would be the same mark on every tile.
             */
            <Link
              className="flex aspect-square flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-testid={`gallery-${component.name}`}
              key={component.name}
              params={{ name: component.name }}
              to="/settings/components-gallery/$name"
            >
              <div className="min-h-28 p-4">
                <h4 className="line-clamp-1 font-medium text-sm">
                  {component.title}
                </h4>
                <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">
                  {galleryComponent(component.name)?.summary ??
                    component.publishedDescription}
                </p>
              </div>
              <div className="relative flex-1">
                <div className="absolute top-0 left-0 h-full w-full p-3">
                  <SettingsItemBackground className="h-full w-full rounded-md" />
                </div>
                <div className="absolute top-0 left-0 z-10 h-full w-full p-3">
                  <ComponentPreview
                    kind={component.kind}
                    name={component.name}
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
