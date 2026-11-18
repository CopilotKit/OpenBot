import type { ReactNode } from "react";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { SidebarInset } from "@/components/ui/sidebar";
import { KiteSidebar } from "./sidebar";

/**
 * Kite Bot's frame: OpenBot's own shell (the sidebar that collapses with ⌘B, is dragged wider at its
 * edge and becomes a sheet on a phone, and the page inset beside it), with Kite Bot's sidebar in it.
 * Every page keeps the toggle it already draws, so a collapsed or phone sidebar always comes back.
 */
export function KiteBotFrame({ children }: { children: ReactNode }) {
  return (
    <SidebarShell className="h-svh overflow-hidden">
      <KiteSidebar />
      <SidebarInset className="min-h-0 overflow-hidden" data-kitebot-page="">
        <ConnectionBanner />
        <UpdateBanner />
        <SelfHostBanner />
        {children}
      </SidebarInset>
    </SidebarShell>
  );
}
