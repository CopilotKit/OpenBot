import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { deploymentKeys } from "@/lib/deployment/queries";

/**
 * The New Bot sheet, open on its first screen, as a page of its own for new-bot-sheet-fit.test.tsx
 * to bundle and load in Chromium. The test answers the sheet's requests; the edition is the team one,
 * where the sheet asks the most.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
queryClient.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute({
    component: () => (
      <NewBotSheet onClose={() => {}} onCreated={() => {}} open />
    ),
  }),
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
