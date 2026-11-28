import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { LIMIT_BOT, LIMIT_ROWS } from "./computer-limit-audit-rows";
import { seedAuditPage } from "./seed-audit-page";

/**
 * Admin's Activity with the rows a limit on computers writes, as a page of its own for
 * audit-computer-limit-layout.test.tsx to bundle and load in a browser. What the server would answer is put in the
 * query cache before the page draws, and kept fresh, so nothing is asked of a server.
 */
setCurrentOrganization("default");
queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
});
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
});
seedAuditPage(queryClient, "", { events: LIMIT_ROWS });
queryClient.setQueryData(agentKeys.list(false), [
  { id: LIMIT_BOT, name: "Notes" },
]);
queryClient.setQueryData(agentKeys.list(true), []);
// Who started each row, by the address the People page shows.
queryClient.setQueryData(organizationKeys.members("default"), [
  { id: "ben", email: "ben.okafor@northwind.example", name: "Ben Okafor" },
]);

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <div className="h-svh overflow-auto bg-background text-foreground">
        <AuditPage />
      </div>
    ),
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
