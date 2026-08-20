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

/**
 * What a Bot can draw, for the person it draws for.
 *
 * The same gallery an administrator governs, with none of the governing. Published components only:
 * an unpublished one is not something any Bot can put on screen, so listing it here would describe a
 * capability nobody has. The description shown is the published one — what the model is actually
 * told — rather than a draft an administrator may be part-way through rewording.
 */
export const Route = createFileRoute("/_authed/settings/components-gallery/")({
  component: RouteComponent,
});

function RouteComponent() {
  const components = useQuery(componentListQueryOptions());
  const published = components.data?.filter((component) => component.published);

  return (
    <PageShell
      description="The pieces a Bot can draw in a conversation instead of describing something in prose. Which of them any one Bot may use is an administrator's decision."
      title="Components gallery"
    >
      {components.isPending ? null : components.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Could not load components.
        </p>
      ) : published?.length === 0 ? (
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>Nothing published yet</EmptyTitle>
            <EmptyDescription className="text-pretty">
              When an administrator publishes a component, it will show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mx-auto mt-12 grid w-full max-w-2xl grid-cols-1 gap-4 md:grid-cols-2">
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
                  {component.publishedDescription}
                </p>
              </div>
              <div className="relative flex-1">
                <div className="absolute top-0 left-0 h-full w-full p-3">
                  <SettingsItemBackground className="h-full w-full rounded-md" />
                </div>
                <div className="absolute top-0 left-0 z-10 h-full w-full p-3">
                  <ComponentPreview name={component.name} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
