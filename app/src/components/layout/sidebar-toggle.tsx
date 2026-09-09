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
 * Whether {@link SidebarToggle} will actually draw anything.
 *
 * Exported because a caller that reserves space for this control has to agree with it about when it
 * exists. `PageShell` draws a 56px bar to hold it, and deciding that on "is there a sidebar" while
 * the toggle decides on something narrower leaves an empty band on every configuration screen —
 * which is the layout bug that file's own comment warns against.
 */
export function useSidebarToggleVisible(): boolean {
  const sidebar = useOptionalSidebar();
  if (!sidebar) return false;
  /*
   * Below 768px the sidebar is an overlay Sheet with its own open state, and `open` describes the
   * desktop pane — reading it there would answer for the wrong one.
   */
  const isOpen = sidebar.isMobile ? sidebar.openMobile : sidebar.open;

  /*
   * Nothing to draw on a desktop-width window while the sidebar is already showing: the roster is
   * on screen, so a button whose whole offer is to take it away is clutter beside the screen's own
   * controls. ⌘B still collapses it for anyone who wants that.
   *
   * Only in THAT state, though, and the distinction is the whole point. The moment the sidebar is
   * gone this is the way back, so it returns — which is what stops this from re-creating the defect
   * the component was written for. Collapsing is remembered across reloads (`lib/sidebar.ts` stores
   * `collapsed`), so a desktop window that hid this in both states would leave somebody who pressed
   * ⌘B once with every channel behind a shortcut nobody told them about. On mobile it always draws:
   * the Sheet starts closed, so hiding it there would mean the roster could never be opened at all.
   */
  return sidebar.isMobile || !isOpen;
}

/**
 * The control that opens and closes the shell's sidebar.
 *
 * WHAT THIS IS FIXING. The sidebar could always collapse — the primitive has had the state, the
 * width transition and a ⌘B shortcut since it was vendored in. Nothing ever rendered a trigger for
 * it. The only affordance was `SidebarRail`, a 16px transparent strip carrying `tabIndex={-1}`, so
 * the eye could not find it and the keyboard could not reach it; and under 768px, where the sidebar
 * becomes a Sheet that starts closed, there was no way to open the roster at all.
 *
 * It is therefore drawn in the chrome each screen already has, rather than inside the sidebar it
 * hides — a trigger that disappears along with the sidebar cannot bring it back. That constraint is
 * about the state where the sidebar is GONE, and it is the one {@link useSidebarToggleVisible} keeps
 * absolutely: the toggle is allowed to stand down while the sidebar is already on screen, but never
 * while it is the way back.
 *
 * Built from `Button` rather than the primitive's `SidebarTrigger` because that component hardcodes
 * its own children after the prop spread, including an `sr-only` "Toggle Sidebar" that would
 * contradict the label below. The state still belongs to the primitive: `toggleSidebar` is its hook.
 */
export function SidebarToggle({ className }: { className?: string }) {
  const sidebar = useOptionalSidebar();
  const visible = useSidebarToggleVisible();
  if (!sidebar || !visible) return null;
  const { isMobile, open, openMobile, toggleSidebar } = sidebar;

  // The label says what the click will do, not what is on screen.
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
 *
 * The band keeps its height even when `SidebarToggle` draws nothing, which on a desktop window is
 * most of the time. That is deliberate: reserving it means the screen beneath does not jump by 48px
 * each time the sidebar is collapsed and the toggle reappears.
 */
export function SidebarToggleBar() {
  return (
    <div className="h-12 shrink-0 flex items-center px-3">
      <SidebarToggle />
    </div>
  );
}
