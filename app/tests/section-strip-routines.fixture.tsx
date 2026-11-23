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
 * The app's frame as section-strip-routines.test.tsx loads it in a browser: the strip of sections
 * and the open section's panel beside a page, as `AppFrame` in `routes/_authed/_app.tsx` draws them.
 * The strip, the panels and the shell are the real ones; OpenBot's API is the test's routes, and the
 * page is only its heading. `?path=` is the page it opens on.
 */
const path = new URLSearchParams(location.search).get("path") ?? "/";

setCurrentOrganization("default");

/** The page's heading, named for the page the strip opened. */
function Page() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const title = pathname.startsWith("/routines")
    ? "Routines"
    : pathname.startsWith("/agents")
      ? "Agents"
      : "Start a conversation";
  return (
    <PageShell title={title}>
      <p data-page={pathname}>The page</p>
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
