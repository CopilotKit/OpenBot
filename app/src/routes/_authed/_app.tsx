import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { WaitingToasts } from "@/components/notifications/waiting-toasts";
import { SidebarProvider } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": "340px",
          "--sidebar-width-mobile": "20rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <Outlet />
      </main>
      {/*
       * Outside the scrolling pane, because a Bot waiting for you is not about whichever screen you
       * are on. Sits above everything in the shell and takes pointer events only on the cards
       * themselves, so it never covers the thing somebody was in the middle of.
       */}
      <WaitingToasts />
    </SidebarProvider>
  );
}
