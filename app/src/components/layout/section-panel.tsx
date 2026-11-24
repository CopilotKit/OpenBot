import type { ReactNode } from "react";
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
 *
 * In OpenBot's own look (Figma "Sidebar", Option 2) the panel is a pale card under the sidebar's
 * title bar, which holds the window's buttons instead: 12px in all round, its left corners 16px, its
 * title in the brand face at 16px with the buttons beside it, and what the section lists 8px under.
 */
export function SectionPanel({
  title,
  actions,
  children,
  className,
  hidden = false,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  hidden?: boolean;
}) {
  return (
    <Sidebar
      collapsible="none"
      data-slot="section-panel"
      data-desktop-drag=""
      className={cn(
        "w-auto min-w-0 flex-1 bg-transparent in-data-[desktop-titlebar=overlay]:pt-8",
        // From `md` the sidebar's title bar holds the window's buttons; a narrow window's sheet has none.
        "kit:rounded-l-xl kit:bg-background/60 kit:p-3 kit:max-md:in-data-[desktop-titlebar=overlay]:pt-8",
        className,
      )}
      hidden={hidden}
    >
      <div
        className="flex h-12 shrink-0 items-center gap-0.5 pr-2 pl-4 kit:h-auto kit:gap-2 kit:py-1 kit:pr-0 kit:pl-0 kit:[&_svg]:size-[18px]"
        data-desktop-drag="deep"
      >
        <h2 className="min-w-0 flex-1 truncate font-semibold text-[15px] tracking-tight kit:font-bold kit:font-brand kit:text-base kit:leading-[1.35] kit:tracking-normal">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </Sidebar>
  );
}
