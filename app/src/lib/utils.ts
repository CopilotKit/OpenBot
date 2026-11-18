import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge resolves two classes for the same property by keeping the later one, but only for
 * values it knows. OpenBot's own theme values (theme.css `@theme`: Figma's 20px card and 12px tile
 * corners, the message box's shadow, the 700px page column, the headings' tracking) are not
 * Tailwind's, so without them here `cn("rounded-lg", "rounded-card")` kept both and the stylesheet's
 * order chose, not the caller.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      container: ["page"],
      radius: ["card", "tile"],
      shadow: ["composer"],
      tracking: ["heading"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
