import { useEffect, useRef, useState } from "react";
import { galleryComponent } from "@/lib/copilot/gallery-registry";

/**
 * The width a gallery component is given to lay out against, standing in for the conversation
 * column: previewing at the tile's own width would be a different component.
 *
 * Only an upper bound, and deliberately not read as the component's width. `GalleryFrame` caps
 * itself at `max-w-2xl`, which is 42rem — 630px against this app's 15px root, not the 672px a 16px
 * root would give. Assuming that number left every preview sitting half the difference off centre,
 * so the drawn width is measured instead.
 */
const PREVIEW_LAYOUT_WIDTH = 672;

/**
 * How much of the space it could fill a preview actually takes, leaving the rest as margin.
 *
 * Padding the tile instead would not do it: the fit is measured against whichever axis runs out
 * first, so a component that binds on height would still meet the top and bottom edges. Holding it
 * off every edge means taking a share of the room on both axes at once.
 */
export const PREVIEW_FILL = 0.85;

/**
 * One component, drawn at its real size and scaled to sit inside the tile.
 *
 * The scale is measured rather than declared. CSS cannot do it: `scale()` needs a unitless number
 * and `calc()` will not divide a length by one, so a container query cannot produce the ratio — and
 * a hard-coded ratio would be wrong as soon as the tile changes shape.
 *
 * It is measured against both axes, because a component's height is its own business: a donut chart
 * and a five-line checklist are the same width and nothing like the same height. Fitting on width
 * alone left the tall ones running out of the bottom of the tile.
 *
 * Never scaled past its natural size, then held to `fill` of what it could fill. A box wider than a
 * conversation column would otherwise magnify a component beyond the size anybody will actually see
 * it at.
 *
 * Drawn inert and hidden from assistive technology. These are the real components, so a decision
 * card here has a real note field and real Approve and Decline buttons; nothing in Admin should be
 * able to reach them, and a screen reader should not find a second set of them on the page.
 */
export function ComponentPreview({
  name,
  fill = PREVIEW_FILL,
}: {
  name: string;
  fill?: number;
}) {
  const entry = galleryComponent(name);
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const outer = box.current;
    const inner = content.current;
    if (!outer || !inner) return;

    const measure = () => {
      /*
       * Measured on the component's own root rather than the box it was handed, because the two are
       * not the same width: the box is the column it lays out against, and the component caps
       * itself inside that. Scaling by the box would shrink it to fit a width it never occupied.
       *
       * `offsetWidth` and `offsetHeight` are laid-out values, which a transform does not touch — so
       * reading them here cannot feed back into the scale about to be applied to them.
       */
      const drawn = inner.firstElementChild;
      const measured = drawn instanceof HTMLElement ? drawn : inner;

      if (!measured.offsetWidth || !measured.offsetHeight) return;
      if (!outer.clientWidth || !outer.clientHeight) return;

      setScale(
        fill *
          Math.min(
            1,
            outer.clientWidth / measured.offsetWidth,
            outer.clientHeight / measured.offsetHeight,
          ),
      );
    };

    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [fill]);

  if (!entry?.preview) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          {entry
            ? "This one is only drawn in a conversation."
            : "This build cannot draw this."}
        </p>
      </div>
    );
  }

  const { Component } = entry;

  return (
    <div
      aria-hidden="true"
      className="flex h-full w-full items-center justify-center overflow-hidden"
      inert
      ref={box}
    >
      {/*
       * Centred by the flex parent and scaled about its own middle. The layout box stays full size
       * and may be larger than the tile, which is what keeps it centred: shrinking happens around
       * the centre point the parent already placed.
       *
       * A flex row itself, so a component narrower than the column it was given is centred in it
       * rather than left against one edge. Whatever `max-w-2xl` resolves to, the slack is split.
       */}
      <div
        className="flex shrink-0 justify-center transition-opacity"
        ref={content}
        style={{
          // Until the tile has been measured there is no honest scale, so draw nothing.
          opacity: scale > 0 ? 1 : 0,
          transform: `scale(${scale})`,
          width: PREVIEW_LAYOUT_WIDTH,
        }}
      >
        <Component {...entry.preview} />
      </div>
    </div>
  );
}
