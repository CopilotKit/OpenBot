import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A glyph with a status dot on its corner: a Bot working, or something waiting on the person.
 *
 * The dot is anchored to the glyph itself. A row's icon is bare (docs/app-guidelines.md, "The
 * look"), so a dot placed on the row's media box would sit in the empty space around the glyph.
 */
function IconDot({
  children,
  dotClassName,
  className,
}: {
  children: React.ReactNode;
  /** The dot's color, and any motion. No dot is drawn without it. */
  dotClassName?: string;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      {children}
      {dotClassName ? (
        <span
          aria-hidden="true"
          data-slot="icon-dot"
          className={cn(
            "absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-card",
            dotClassName,
          )}
        />
      ) : null}
    </span>
  );
}

export { IconDot };
