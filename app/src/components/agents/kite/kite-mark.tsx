import { useId } from "react";
import { cn } from "@/lib/utils";
import { KITE, KITE_PATH } from "./kite";

/**
 * OpenBot's own kite, as a mark: the Bots' silhouette in one solid ink, with its two spars cut out
 * of it, so it reads as the product rather than as one more Bot. It takes the colour of the text
 * around it, which is what lets a skin set it in black, white or anything else.
 */
export function KiteMark({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const id = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-spars`;
  // The spars are cut a whole pixel wide wherever the mark is drawn, so they never blur away.
  const spar = Math.max(1, Math.round(size * 0.055)) / size;
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      height={size}
      style={{ height: size, width: size }}
      viewBox="-0.5 -0.5 1 1"
      width={size}
    >
      <defs>
        <mask
          height="1"
          id={id}
          maskUnits="userSpaceOnUse"
          width="1"
          x="-0.5"
          y="-0.5"
        >
          <rect fill="#fff" height="1" width="1" x="-0.5" y="-0.5" />
          <g fill="none" stroke="#000" strokeWidth={spar}>
            <path d={`M0 ${KITE.nose[1]}V${KITE.tail[1]}`} />
            <path d={`M${KITE.left[0]} ${KITE.cross[1]}H${KITE.right[0]}`} />
          </g>
        </mask>
      </defs>
      <path
        d={KITE_PATH}
        fill="currentColor"
        mask={`url(#${id})`}
        shapeRendering="geometricPrecision"
      />
    </svg>
  );
}
