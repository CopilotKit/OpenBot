import type { Icon, IconProps } from "@tabler/icons-react";
import { forwardRef } from "react";
import logo from "@/assets/openbot-logo.png";

/**
 * OpenBot's own mark, the orb the desktop app and the extension use, drawn where a navigation icon
 * goes. An SVG around the picture, so every frame sizes it with the same rules it sizes its Tabler
 * icons by; `stroke` is accepted and ignored, because there is no line to draw.
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
      <image height="24" href={logo} width="24" />
    </svg>
  ),
) as unknown as Icon;
OpenBotLogo.displayName = "OpenBotLogo";
