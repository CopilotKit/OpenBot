import { IconLayoutSidebar } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * ⌘ on Apple platforms, Ctrl everywhere else. The primitive's listener accepts either modifier, so
 * this only decides which of the two to name.
 */
const SHORTCUT_LABEL = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  ? "⌘B"
  : "Ctrl+B";

/**
 * The control that opens and closes the shell's sidebar.
 *
 * WHAT THIS IS FIXING. The sidebar could always collapse — the primitive has had the state, the
 * width transition and a ⌘B shortcut since it was vendored in. Nothing ever rendered a trigger for
 * it. The only affordance was `SidebarRail`, a 16px transparent strip carrying `tabIndex={-1}`, so
 * the eye could not find it and the keyboard could not reach it; and under 768px, where the sidebar
 * becomes a Sheet that starts closed, there was no way to open the roster at all.
 *
 * It is therefore drawn in the chrome each screen already has, and in BOTH states, rather than
 * inside the sidebar it hides — a trigger that disappears along with the sidebar cannot bring it
 * back.
 *
 * Built from `Button` rather than the primitive's `SidebarTrigger` because that component hardcodes
 * its own children after the prop spread, including an `sr-only` "Toggle Sidebar" that would
 * contradict the label below. The state still belongs to the primitive: `toggleSidebar` is its hook.
 */
export function SidebarToggle({ className }: { className?: string }) {
  const sidebar = useOptionalSidebar();
  // No sidebar in scope, so nothing to toggle and nothing to draw.
  if (!sidebar) return null;
  const { isMobile, open, openMobile, toggleSidebar } = sidebar;
  /*
   * The label says what the click will do, not what is on screen. Below 768px the sidebar is an
   * overlay Sheet with its own open state, and `open` describes the desktop pane — reading it there
   * would name the wrong action.
   */
  const label = (isMobile ? openMobile : open)
    ? "Hide sidebar"
    : "Show sidebar";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn("text-muted-foreground", className)}
            onClick={toggleSidebar}
            size="icon"
            variant="ghost"
          >
            <IconLayoutSidebar className="size-4.5" />
          </Button>
        }
      />
      {/* An accelerator nobody is told about is not a feature. */}
      <TooltipContent side="bottom">
        {label}
        <span className="text-background/60">{SHORTCUT_LABEL}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The toggle on a screen that draws no header of its own.
 *
 * Three `_app` screens open straight into their content, and the toggle still has to land in the
 * same 48px band it occupies everywhere else — a control that moves between screens is a control
 * somebody has to look for each time. No bottom border: a divider under an otherwise empty bar is a
 * line with nothing to divide.
 */
export function SidebarToggleBar() {
  return (
    <div className="h-12 shrink-0 flex items-center px-3">
      <SidebarToggle />
    </div>
  );
}
