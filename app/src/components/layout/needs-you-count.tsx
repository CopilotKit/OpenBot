import { cn } from "@/lib/utils";

/**
 * How many things wait on the person, as a small count in the needs colour: the colour of every
 * other mark that says something needs you, so a count reads as one at a glance. Nothing for zero.
 *
 * Named for what it counts where it stands alone, as beside a destination in the sidebar. A row
 * that already says what waits in its own accessible name passes `decorative`.
 */
export function NeedsYouCount({
  count,
  decorative = false,
  className,
}: {
  count: number;
  decorative?: boolean;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      {...(decorative
        ? { "aria-hidden": true }
        : {
            "aria-label": `${count} ${count === 1 ? "thing needs" : "things need"} you`,
            role: "img",
          })}
      className={cn(
        "rounded-full bg-status-needs-soft px-1.5 text-[11px] font-medium text-status-needs tabular-nums",
        className,
      )}
      data-slot="needs-you-count"
    >
      {count}
    </span>
  );
}
