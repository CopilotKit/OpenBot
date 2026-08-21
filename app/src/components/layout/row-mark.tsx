import type * as React from "react";
import { ItemMedia } from "@/components/ui/item";
import { cn } from "@/lib/utils";

/**
 * A row's leading icon, as a tile rather than a bare glyph.
 *
 * A DELIBERATE DEVIATION from the default row anatomy, which is `ItemMedia variant="icon"` and
 * nothing else. Stated here because the layout skill asks for a reason when a screen departs from it.
 *
 * FOR ONE LIST ONLY: the connectors on `admin/plugins`. Every row there is another company, and the
 * tile carries that vendor's own mark — so it is doing work no other row in the app needs, which is
 * telling third parties apart at a glance. `variant="icon"` puts a 15px glyph straight against the
 * text, and a list of vendors read that way has no fixed left edge for the eye to run down.
 *
 * Not for a detail page, and not for skills. Those rows are this deployment's own settings and its
 * own instructions; there is no third party to identify, so they take the standard media and the
 * screens stay consistent with the other eleven that use it.
 *
 * One component rather than a class literal at every call site, because the whole value is that the
 * tiles are identical: copies of `size-9 rounded-lg bg-muted/60` are chances for one of them to
 * drift, and a list with one tile a pixel out looks broken rather than varied.
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
