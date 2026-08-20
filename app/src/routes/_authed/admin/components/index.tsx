import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ComponentPreview } from "@/components/admin/component-preview";
import { PageShell } from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { componentListQueryOptions } from "@/lib/components/queries";
import { cn } from "@/lib/utils";

/**
 * The gallery of compiled components. Governance for any one of them is its own page, because a
 * component carries per-Bot grants, per-function grants and an editable description — more than a
 * tile can hold.
 */
export const Route = createFileRoute("/_authed/admin/components/")({
  component: RouteComponent,
});

function RouteComponent() {
  const components = useQuery(componentListQueryOptions());

  return (
    <PageShell
      description="What each Bot may answer with. Every published component is available to every Bot; switch one off here and that Bot is never told about it. Each change and each refusal is a row in Audit."
      title="UI Components"
    >
      {/*
       * Pending, error, empty, rows — in that order. Pending draws nothing rather than a
       * placeholder, and it has to come first: the empty sentence would otherwise stand there
       * asserting there are no components for as long as the fetch takes.
       */}
      {components.isPending ? null : components.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Could not load components.
        </p>
      ) : components.data?.length === 0 ? (
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No components yet</EmptyTitle>
            <EmptyDescription className="text-pretty">
              Components that your Agents can use will be shown here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mx-auto mt-12 grid w-full max-w-2xl grid-cols-1 gap-4 md:grid-cols-2">
          {components.data?.map((component) => (
            /*
             * A real link rather than a button, so a component can be opened in a new tab the way
             * anything else addressable can. Its name comes from the title and description below:
             * the preview is `aria-hidden`, so nothing inside it reaches the accessible name.
             */
            <Link
              className="flex aspect-square flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-testid={`component-${component.name}`}
              key={component.name}
              params={{ name: component.name }}
              to="/admin/components/$name"
            >
              <div className="min-h-28 p-4">
                <div className="flex flex-row items-center gap-2">
                  <div
                    className={cn("inline-block size-1.5 rounded-full", {
                      "bg-muted-foreground": !component.published,
                      "bg-success": component.published,
                    })}
                  />
                  <h4 className="line-clamp-1 font-medium text-sm">
                    {component.title}
                  </h4>
                </div>
                <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">
                  {component.draftDescription}
                </p>
              </div>
              <div className="relative flex-1">
                {/*
                 * The artwork is sized explicitly. Left to itself it carries a viewBox and no width
                 * or height, which resolves to the full width and a height derived from its 3:2
                 * ratio — taller than this box, and `overflow-hidden` clips at the border rather
                 * than the padding, so it escaped the inset and met the tile's corners square.
                 * `slice` crops it to whatever shape it is given instead.
                 */}
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
