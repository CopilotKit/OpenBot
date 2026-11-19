import type { ReactNode } from "react";
import { Sidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * The panel beside the strip: the open section's title, its buttons at the right of the title, and
 * what the section lists under them. It fills whatever width the strip leaves.
 */
export function SectionPanel({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Sidebar
      collapsible="none"
      data-slot="section-panel"
      className={cn("w-auto min-w-0 flex-1 bg-transparent", className)}
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
