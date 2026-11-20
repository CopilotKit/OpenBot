import type { ReactNode } from "react";
import { Sidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * The panel beside the strip: the open section's title, its buttons at the right of the title, and
 * what the section lists under them. It fills whatever width the strip leaves.
 *
 * `hidden` keeps a panel that is not the open section's mounted out of sight, so going back to it
 * finds it as it was left: its search, its scroll, what is open in it.
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
      className={cn("w-auto min-w-0 flex-1 bg-transparent", className)}
      hidden={hidden}
    >
      <div className="flex h-12 shrink-0 items-center gap-0.5 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-[15px] tracking-tight">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </Sidebar>
  );
}
