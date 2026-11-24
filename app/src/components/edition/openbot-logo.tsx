import type { Icon, IconProps } from "@/components/icons";
import { forwardRef } from "react";
import orb from "@/assets/openbot-orb.png";
import logo from "@/assets/openbot-logo.png";
import { useKit } from "@/skins/store";

/**
 * OpenBot's own mark, drawn where a navigation icon goes. An SVG around the picture, so every frame
 * sizes it with the same rules it sizes its icons by; `stroke` is accepted and ignored, because there
 * is no line to draw.
 *
 * In the current kit (skins/kit.ts) it is Figma's "Brand / Logo Artwork": the pastel orb of the new
 * wordmark, cut from Figma's logo picture at 96px, four times the 24px it is drawn at. The legacy
 * kit's skins keep the orb the desktop app and the extension use.
 */
export const OpenBotLogo = forwardRef<SVGSVGElement, IconProps>(
  ({ size = 24, stroke: _stroke, ...props }, ref) => {
    const currentKit = useKit() === "current";
    return (
      <svg
        aria-hidden="true"
        height={size}
        ref={ref}
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <image height="24" href={currentKit ? orb : logo} width="24" />
      </svg>
    );
  },
) as unknown as Icon;
OpenBotLogo.displayName = "OpenBotLogo";
