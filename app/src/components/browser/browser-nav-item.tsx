import { IconBrowser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { browserStateQueryOptions } from "@/lib/browser/queries";

/**
 * The sidebar's Browser button, beside Bots, Capabilities and Connections: the person's own browser, with the Recorder
 * in it.
 *
 * Drawn only once the server has said OpenBot can run a browser for this person (`available`). While it is asked, and
 * when it cannot be asked, there is no button, rather than one that opens a page saying there is nothing there.
 */
export function BrowserNavItem() {
  const state = useQuery(browserStateQueryOptions());
  if (state.isPending || !state.data?.available) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="hover:bg-foreground/5 h-10"
        render={(props) => (
          <Link
            {...props}
            to="/browser"
            activeProps={{ className: "bg-foreground/5" }}
          />
        )}
      >
        <div className="size-[28px] flex items-center justify-center">
          <IconBrowser />
        </div>
        <span className="text-sm">Browser</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
