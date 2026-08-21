import type * as React from "react";
import { ItemMedia } from "@/components/ui/item";
import { cn } from "@/lib/utils";

/**
 * A row's leading icon, as a tile rather than a bare glyph.
 *
 * A DELIBERATE DEVIATION from the default row anatomy, which is `ItemMedia variant="icon"` and
 * nothing else. Stated here because the layout skill asks for a reason when a screen departs from it.
 *
 * The reason is scanning. `variant="icon"` only sizes the svg, so a 15px glyph sits directly against
 * the row's text and the eye has no fixed left edge to run down — a list of ten reads as ten
 * paragraphs. A filled square of a constant size gives every row the same visual anchor whatever
 * its icon, which is what makes a settings list scannable in one pass.
 *
 * One component rather than a class literal at every call site, because the whole value is that the
 * tiles are identical. Eleven copies of `size-9 rounded-lg bg-muted/60` is eleven chances for
 * one of them to drift, and a list with one tile a pixel out looks broken rather than varied.
 */
export function RowMark({
  className,
  ...props
}: React.ComponentProps<typeof ItemMedia>) {
  return (
    <ItemMedia
      className={cn(
        "size-9 rounded-lg bg-muted/60 text-muted-foreground",
        className,
      )}
      variant="icon"
      {...props}
    />
  );
}
