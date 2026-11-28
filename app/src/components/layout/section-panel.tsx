import "../app-sidebar/mobile-panels.css";
import type { ReactNode } from "react";
import { ShellAccountMenu } from "@/components/layout/native-shell-account";
import { Sidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * The panel beside the strip: the open section's title, its buttons at the right of the title, and
 * what the section lists under them. It fills whatever width the strip leaves.
 *
 * `hidden` keeps a panel that is not the open section's mounted out of sight, so going back to it
 * finds it as it was left: its search, its scroll, what is open in it.
 *
 * In OpenBot Desktop on macOS the window's buttons sit over the sidebar's top-left corner
 * (`data-desktop-titlebar`, macOS only), so the panel then starts 32px lower, below them, level with
 * the strip (`Strip`). The room above it and the title's row move the window, as a Mac title bar
 * does; the title's buttons stay buttons (`data-desktop-drag`, "deep" for the row).
 */
export function SectionPanel({
  title,
  actions,
  children,
  search,
  className,
  hidden = false,
  standalone = false,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  search?: ReactNode;
  className?: string;
  hidden?: boolean;
  /** Fill a native tab with the section instead of mounting it inside the desktop sidebar. */
  standalone?: boolean;
}) {
  const Heading = standalone ? "h1" : "h2";
  const content = (
    <>
      <div
        className={cn(
          "flex h-12 shrink-0 items-center gap-0.5 pr-2 pl-4",
          standalone && "native-panel-heading",
        )}
        data-desktop-drag="deep"
      >
        <Heading className="min-w-0 flex-1 truncate font-semibold text-base tracking-tight">
          {title}
        </Heading>
        {actions}
        {standalone && <ShellAccountMenu />}
      </div>
      {standalone && search}
      {children}
    </>
  );

  // A native tab fills the screen with the panel; the OS supplies its navigation.
  if (standalone) {
    return (
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
        data-slot="native-tab-panel"
      >
        {content}
      </section>
    );
  }
  return (
    <Sidebar
      collapsible="none"
      data-slot="section-panel"
      data-desktop-drag=""
      className={cn(
        "w-auto min-w-0 flex-1 bg-transparent in-data-[desktop-titlebar=overlay]:pt-8",
        className,
      )}
      hidden={hidden}
    >
      {content}
    </Sidebar>
  );
}
