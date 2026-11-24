import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Checkbox } from "@/components/ui/checkbox";
import { modelKeys } from "@/lib/models/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * Unticked tickboxes where the app draws them, as a page of its own for checkbox-contrast.test.tsx
 * to bundle and load in a browser: the tickbox on each surface the app puts it on: the page, a card,
 * a menu or dialog, and a row filled with `bg-muted/50` on a card. The
 * test sets light or dark on the page's root, as the app's theme does.
 *
 * What the server would answer is put in the query cache before the page draws, and kept fresh, so
 * nothing is asked of a server.
 */
setCurrentOrganization("default");

queryClient.setQueryDefaults(["models"], { staleTime: Infinity });
queryClient.setQueryData(modelKeys.catalogue, { models: [] });

/** One unticked tickbox with its label, on a surface of the app's. */
function OnSurface({ id, surface }: { id: string; surface: string }) {
  return (
    <div className={`flex items-center gap-3 rounded-lg p-3 ${surface}`}>
      <Checkbox data-surface={id} id={`on-${id}`} />
      <label className="text-sm" htmlFor={`on-${id}`}>
        On {id}
      </label>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <main className="min-h-svh bg-background p-6 text-foreground">
        <div className="mx-auto grid max-w-2xl gap-3" data-screen="surfaces">
          <OnSurface id="page" surface="bg-background" />
          <div className="rounded-xl bg-card p-3">
            <OnSurface id="card" surface="bg-card" />
            <OnSurface id="muted row" surface="bg-muted/50" />
          </div>
          <OnSurface id="popover" surface="bg-popover" />
        </div>
      </main>
    </QueryClientProvider>,
  );
