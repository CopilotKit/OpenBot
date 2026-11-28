import { IconSettings } from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { PageShell } from "@/components/layout/page-shell";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { MovedAppsBanner } from "@/components/moves/moved-apps-notice";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { Button } from "@/components/ui/button";
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
 * The three shells as sidebar-window-buttons.test.tsx loads them in a browser: the app's frame (the
 * strip of sections and the open section's panel, as `routes/_authed/_app.tsx` draws it), and
 * Admin's and Settings' (`routes/_authed/admin/route.tsx`, `settings/route.tsx`), each with a page
 * beside it. The sidebars, the shell, the bars over the app's page and the page's top bar are the
 * real ones; OpenBot's API is the test's routes, which say whether the bars show.
 *
 * `?shell=app|admin|settings` picks the shell and `&path=` the page it opens on, which for the app
 * picks the open section: `/` is Conversations', `/bots` is Bots'.
 */
const query = new URLSearchParams(location.search);
const shell = query.get("shell") ?? "app";
const path = query.get("path") ?? "/";

setCurrentOrganization("default");

/** The app's frame, as `AppFrame` in `routes/_authed/_app.tsx` draws it. */
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
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* Two of the bars `_app.tsx` draws over the page; each draws nothing unless the API asks. */}
        <MovedAppsBanner />
        <SelfHostBanner />
        {/* The page's own top bar, with a control at its right end as a conversation's has. */}
        <div data-page-bar="">
          <SidebarToggleBar>
            <Button
              aria-label="This conversation's Bot"
              size="icon"
              variant="ghost"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </SidebarToggleBar>
        </div>
        <h1 data-page="" className="px-6 font-semibold text-2xl">
          Start a conversation
        </h1>
      </SidebarInset>
    </SidebarShell>
  );
}

/** Admin's or Settings' shell, around a page drawn as theirs are. */
function OnePanel({ admin }: { admin: boolean }) {
  return (
    <SidebarShell className="h-svh overflow-hidden">
      {admin ? <AdminSidebar /> : <SettingsSidebar />}
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <PageShell
          description="What every Bot may do."
          title={admin ? "Overview" : "General"}
        >
          <p data-page="">The page</p>
        </PageShell>
      </SidebarInset>
    </SidebarShell>
  );
}

function Screen() {
  if (shell === "admin") return <OnePanel admin />;
  if (shell === "settings") return <OnePanel admin={false} />;
  return (
    <SectionProvider>
      <AppFrame />
    </SectionProvider>
  );
}

const router = createRouter({
  history: createMemoryHistory({ initialEntries: [path] }),
  routeTree: createRootRoute({
    component: Screen,
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
