import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCurrentOrganization } from "@/lib/organizations/current";
import {
  CONVERSATIONS,
  SectionProvider,
  sectionHasPanel,
  useOpenSection,
} from "@/lib/sections";
import { queryClient } from "@/query-client";

/**
 * The app's frame as bots-panel-start-conversation.test.tsx loads it in a browser: the strip, the
 * Bots panel and the shell are the app's own, as `AppFrame` in `routes/_authed/_app.tsx` draws them.
 * OpenBot's API is the test's routes, and the page is only its heading, which says where the app is
 * and which Bot a new conversation is for. `?path=` is the page it opens on.
 */
const path = new URLSearchParams(location.search).get("path") ?? "/bots";

setCurrentOrganization("default");

function Page() {
  const location = useRouterState({ select: (state) => state.location });
  const agent = (location.search as { agent?: unknown }).agent;
  const title =
    location.pathname === "/channel/new" ? "New conversation" : "Bots";
  return (
    <PageShell title={title}>
      <p
        data-agent={typeof agent === "string" ? agent : ""}
        data-page={location.pathname}
      >
        The page
      </p>
    </PageShell>
  );
}

function AppFrame() {
  const { section, show } = useOpenSection();
  return (
    <SidebarShell
      className="h-svh overflow-hidden"
      panel={{
        available: sectionHasPanel(section),
        reveal: () => show(CONVERSATIONS),
      }}
    >
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <SidebarToggleBar />
        <Page />
      </SidebarInset>
    </SidebarShell>
  );
}

const router = createRouter({
  history: createMemoryHistory({ initialEntries: [path] }),
  routeTree: createRootRoute({
    component: () => (
      <SectionProvider>
        <AppFrame />
      </SectionProvider>
    ),
    notFoundComponent: () => null,
  }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
