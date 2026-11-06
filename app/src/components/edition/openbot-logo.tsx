import type { Icon, IconProps } from "@tabler/icons-react";
import { type CSSProperties, forwardRef } from "react";
import { OPENBOT_SLOT, tones } from "@/components/agents/kite/kite-draw";

const LIGHT = tones(OPENBOT_SLOT, false);
const DARK = tones(OPENBOT_SLOT, true);

/** The kite in a 24 px slot, as `kite-draw.ts` builds it: nose, right, tail, left, and the cross. */
const T = "12,1.2";
const R = "22.8,9.84";
const B = "12,22.8";
const L = "1.2,9.84";
const X = "12,9.84";

/**
 * OpenBot's own mark, its kite at rest (violet quarters, no face), drawn where a navigation icon
 * goes. At icon sizes the mascot has no texture: it is a clean flat shape. An SVG, so every frame
 * sizes it with the same rules it sizes its Tabler icons by; `stroke` is accepted and ignored,
 * because there is no line to draw.
 */
export const OpenBotLogo = forwardRef<SVGSVGElement, IconProps>(
  ({ size = 24, stroke: _stroke, ...props }, ref) => (
    <svg
      aria-hidden="true"
      height={size}
      ref={ref}
      style={
        {
          "--openbot-kite": LIGHT.base,
          "--openbot-kite-sail": LIGHT.light,
          "--openbot-kite-dark": DARK.base,
          "--openbot-kite-sail-dark": DARK.light,
        } as CSSProperties
      }
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <polygon
        className="fill-(--openbot-kite) dark:fill-(--openbot-kite-dark)"
        points={`${T} ${R} ${B} ${L}`}
      />
      <g className="fill-(--openbot-kite-sail) dark:fill-(--openbot-kite-sail-dark)">
        <polygon points={`${T} ${R} ${X}`} />
        <polygon points={`${L} ${X} ${B}`} />
      </g>
    </svg>
  ),
) as unknown as Icon;
OpenBotLogo.displayName = "OpenBotLogo";
