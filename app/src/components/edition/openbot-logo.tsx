import type { Icon, IconProps } from "@tabler/icons-react";
import { type CSSProperties, forwardRef } from "react";
import { KITE_COLORS, OPENBOT_SLOT } from "@/components/agents/kite/kite-draw";

const VIOLET = KITE_COLORS[OPENBOT_SLOT];

/**
 * OpenBot's own mark, its kite asleep (violet, a plain sail, no face), drawn where a navigation
 * icon goes. The kite's outline is `kite-draw.ts`'s in a 24 px slot, with no texture: at icon sizes
 * the mascot is a clean flat shape. An SVG, so every frame sizes it with the same rules it sizes its
 * Tabler icons by; `stroke` is accepted and ignored, because there is no line to draw.
 */
export const OpenBotLogo = forwardRef<SVGSVGElement, IconProps>(
  ({ size = 24, stroke: _stroke, ...props }, ref) => (
    <svg
      aria-hidden="true"
      height={size}
      ref={ref}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <polygon
        className="fill-(--openbot-kite) dark:fill-(--openbot-kite-dark)"
        points="12,1.2 22.8,9.84 12,22.8 1.2,9.84"
        style={
          {
            "--openbot-kite": VIOLET.hex,
            "--openbot-kite-dark": VIOLET.darkHex,
          } as CSSProperties
        }
      />
    </svg>
  ),
) as unknown as Icon;
OpenBotLogo.displayName = "OpenBotLogo";
