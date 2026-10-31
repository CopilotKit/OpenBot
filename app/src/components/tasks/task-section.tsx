import { IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * One group of the Tasks list: its name and how many, in muted words so the rows lead, then its
 * rows. Given `onToggle`, the heading is a button that folds the group, as Done starts.
 */
export function TaskSection({
  label,
  count,
  open = true,
  onToggle,
  children,
}: {
  label: string;
  /** Left off until it is known, so a heading never states a wrong number. */
  count?: number;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const heading = (
    <>
      <span>{label}</span>
      {count === undefined ? null : (
        <span className="tabular-nums">{count}</span>
      )}
    </>
  );
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2
        className="type-caption flex min-h-8 items-center px-3 font-medium text-muted-foreground"
        id={id}
      >
        {onToggle ? (
          <button
            aria-expanded={open}
            className="-mx-1 flex min-h-8 flex-1 items-center gap-1.5 rounded-md px-1 text-left outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={onToggle}
            type="button"
          >
            {heading}
            <IconChevronRight
              aria-hidden
              className={cn(
                "ml-auto size-4 transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="flex items-center gap-1.5">{heading}</span>
        )}
      </h2>
      {open ? children : null}
    </section>
  );
}
