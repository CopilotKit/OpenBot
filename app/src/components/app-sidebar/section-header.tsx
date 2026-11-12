import { IconChevronRight } from "@tabler/icons-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A sidebar section's header row: chevron, title, and how many conversations it holds.
 *
 * The whole row is the toggle, and it is a button rather than a link so a folded section is still
 * reachable by keyboard and says so to a screen reader (`aria-expanded`). The chevron points the way
 * the section opens rather than naming the state, which is the one animation this row has.
 */
export function SectionHeader({
  bodyId,
  title,
  count,
  collapsed,
  onToggle,
  action,
}: {
  /** The id of the list this header folds, so `aria-controls` names something that exists. */
  bodyId: string;
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Sits beside the title and does not toggle anything, such as the Projects section's "+". */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 px-1.5 pt-2">
      <button
        aria-controls={bodyId}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        onClick={onToggle}
        type="button"
      >
        <IconChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <span className="truncate">{title}</span>
        {/* The count is a number beside a word, not a badge: a column of pills down the sidebar
            would outweigh the conversations they count. */}
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          {count}
        </span>
      </button>
      {action}
    </div>
  );
}

/**
 * What an empty section says in the place a conversation would be.
 *
 * Plain text rather than the app's `Empty` card: three of those stacked down the sidebar would be
 * three framed boxes where the person expected their conversations, and this is a line about one
 * section, not a screen about the whole roster.
 */
export function SectionEmpty({
  text,
  hint,
}: {
  text: string;
  /** One sentence about how a conversation gets here. The Projects hint is the only one today. */
  hint?: string;
}) {
  return (
    <p className="px-3 pb-1 text-muted-foreground text-xs">
      {text}
      {hint ? (
        <span className="mt-0.5 block text-pretty text-muted-foreground/70 leading-snug">
          {hint}
        </span>
      ) : null}
    </p>
  );
}