import { IconMessages, IconRobot } from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { BotsPanel } from "@/components/app-sidebar/bots-panel";
import { ConversationsPanel } from "@/components/app-sidebar/conversations-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Strip, StripItem } from "@/components/layout/strip";
import { Sidebar, SidebarInset, SidebarRail } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * The app's sidebar as roster-working.test.tsx loads it in a browser: the strip, and beside it the
 * real Conversations panel (or, with `?screen=bots`, the real Bots panel), kept live by the app's own
 * socket hook (`useChannelEvents`), which the test answers as the server does. `?theme=dark` draws it
 * in the dark scheme. `window.readEverything` reads every query again, as giving a Bot an app does.
 */
const query = new URLSearchParams(location.search);
const screen = query.get("screen");
if (query.get("theme") === "dark")
  document.documentElement.classList.add("dark");

setCurrentOrganization("default");

declare global {
  interface Window {
    readEverything?: () => Promise<void>;
  }
}
window.readEverything = () => queryClient.invalidateQueries();

function Live() {
  useChannelEvents();
  return null;
}

function Screen() {
  return (
    <SidebarShell
      className="h-svh overflow-hidden"
      panel={{ available: true, reveal: () => {} }}
    >
      <Live />
      <Sidebar className="overflow-hidden" collapsible="icon" variant="inset">
        <div className="flex h-full min-h-0 flex-row">
          <Strip>
            <StripItem
              active={screen !== "bots"}
              icon={IconMessages}
              label="Conversations"
            />
            <StripItem
              active={screen === "bots"}
              icon={IconRobot}
              label="Bots"
            />
          </Strip>
          {screen === "bots" ? <BotsPanel /> : <ConversationsPanel />}
        </div>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <div className="p-6 text-muted-foreground text-sm">
          Working on 3 subtasks…
        </div>
      </SidebarInset>
    </SidebarShell>
  );
}

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: createRootRoute({ component: Screen }),
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
