import type * as React from "react";

/**
 * The muted frame every picture in onboarding sits in, the same one the computer illustration has.
 *
 * Without it a picture of a composer or of Bot cards reads as the real thing, and people click it
 * and nothing happens. The frame says "this is an illustration" before anybody tries.
 *
 * NOTHING INSIDE IS REACHABLE, BY ANY ROUTE. `pointer-events-none` stops the mouse but not the
 * keyboard: the composer drawn on the Welcome slide still put its editor, Dictate and Send in the Tab
 * order, and a screen reader announced an editable message box. `inert` takes the whole subtree out
 * of focus and out of the accessibility tree, and the outer `role="img"` with its label is what is
 * read in its place: one picture, described once.
 *
 * The label sits on a wrapper rather than on the inert element because an inert element is removed
 * from the accessibility tree along with everything in it, its own name included.
 */
export function IllustrationFrame({
  label,
  children,
  className = "",
}: {
  /** What the picture shows, read in place of the controls drawn inside it. */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div aria-label={label} className="w-full max-w-lg" role="img">
      <div
        className={`pointer-events-none select-none rounded-2xl border border-border bg-muted/60 ${className}`}
        inert
      >
        {children}
      </div>
    </div>
  );
}
