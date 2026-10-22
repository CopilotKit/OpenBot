import { IconChartDots, IconLoader2 } from "@tabler/icons-react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import {
  desktopShell,
  type ShellIpc,
  useIntelligenceDashboard,
} from "@/lib/desktop/intelligence-dashboard";

/**
 * Intelligence, beside Skills and Agents, inside OpenBot Desktop with a local Intelligence stack.
 *
 * It opens the dashboard in the browser rather than navigating here, so it is a button, not a link.
 * The row says it is opening the moment it is pressed and stays disabled until the browser has it.
 */
export function IntelligenceRow({
  shell = desktopShell(),
}: {
  shell?: ShellIpc | null;
}) {
  const dashboard = useIntelligenceDashboard(shell);
  if (!dashboard.available) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-busy={dashboard.opening}
        className="hover:bg-foreground/5 h-10"
        disabled={dashboard.opening}
        onClick={dashboard.open}
      >
        <div className="size-[28px] flex items-center justify-center">
          {dashboard.opening ? (
            <IconLoader2
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          ) : (
            <IconChartDots aria-hidden="true" />
          )}
        </div>
        <span className="text-sm trackint-tight">
          {dashboard.opening ? "Opening…" : "Intelligence"}
        </span>
      </SidebarMenuButton>
      {dashboard.failure ? (
        <p
          className="px-2 pb-1 text-xs text-muted-foreground text-pretty"
          role="status"
        >
          {dashboard.failure}
        </p>
      ) : null}
    </SidebarMenuItem>
  );
}
