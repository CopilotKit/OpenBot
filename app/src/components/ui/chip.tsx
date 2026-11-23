import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * The UI Kit's "chip": one fact about a thing (its Bot, when it last ran, when it runs next), in
 * 12px ink on the secondary fill, a pill 4px by 8px in and 6px on a side that leads with a picture
 * (`ChipMedia`, a Bot's orb). Chips sit 2px apart in a row. A chip says something and does
 * nothing: anything pressable is a `Button`.
 *
 * Drawn only by the current kit's screens so far (a routine's card), so it has no legacy look.
 */
function Chip({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="chip"
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-secondary px-2 text-foreground text-xs has-data-[slot=chip-media]:pl-1.5",
        className,
      )}
      {...props}
    />
  );
}

/** The picture a chip leads with, 16px. Hidden from a screen reader: the chip's words name it. */
function ChipMedia({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="chip-media"
      className={cn("flex size-4 shrink-0", className)}
      {...props}
    />
  );
}

export { Chip, ChipMedia };
