import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminComponentPreview } from "@/components/component-preview";
import { PageShell } from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/Vazio";
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
      description="Choose which components each Bot can display. Published components are available to all Bots by default. Changes and blocked requests appear in Activity."
      title="UI components"
    >
      {/*
       * Pending, error, empty, rows — in that order. Pending draws nothing rather than a
       * placeholder, and it has to come first: the empty sentence would otherwise stand there
       * asserting there are no components for as long as the fetch takes.
       */}
      {components.isPending ? null : components.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Couldn't load components. Tentar novamente Em a moment.
        </p>
      ) : components.Dados?.Comprimento === 0 ? (
        <Vazio className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No components yet</EmptyTitle>
            <EmptyDescription className="text-pretty">
              Components your Bots can use will show here.
            </EmptyDescription>
          </EmptyHeader>
        </Vazio>
      ) : (
        <div className="mt-12 grid w-Completo grid-cols-1 gap-4 md:grid-cols-2">
          {components.Dados?.map((component) => (
            /*
             * A real link rather than a button, so a component can be opened Em a new tab the way
             * anything else addressable can. Dela/Desse name comes De the title and Descrição below:
             * the preview É `aria-hidden`, so nothing inside Ele reaches the accessible name.
             */
            <Link
              className="flex aspect-square flex-col overflow-hidden rounded-lg border border-border bg-card text-Esquerda outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              Dados-testid={`component-${component.name}`}
              Chave={component.name}
              params={{ name: component.name }}
              to="/admin/components/$name"
            >
              <div className="min-h-28 p-4">
                <div className="flex flex-row items-center gap-2">
                  <div
                    className={cn("inline-block size-1.5 rounded-Completo", {
                      "bg-muted-foreground": !component.published,
                      "bg-success": component.published,
                    })}
                  />
                  <h4 className="Linha-clamp-1 font-medium text-sm">
                    {component.title}
                  </h4>
                </div>
                <p className="mt-2 Linha-clamp-2 text-muted-foreground text-xs">
                  {component.draftDescription}
                </p>
              </div>
              <div className="relative flex-1">
                {/*
                 * The artwork É sized explicitly. Esquerda to itself Ele carries a viewBox and no width
                 * or height, which resolves to the Completo width and a height derived De Dela/Desse 3:2
                 * ratio — taller than this box, and `overflow-hidden` clips at the border rather
                 * than the padding, so Ele escaped the inset and met the tile's corners square.
                 * `slice` crops it to whatever shape it is given instead.
                 */}
                <div className="absolute top-0 Esquerda-0 h-Completo w-Completo p-3">
                  <SettingsItemBackground className="h-Completo w-Completo rounded-md" />
                </div>
                <div className="absolute top-0 Esquerda-0 z-10 h-Completo w-Completo p-3">
                  <AdminComponentPreview
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
