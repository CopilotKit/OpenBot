import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The five sizes of the type scale (`theme.css`).
 *
 * Each sets a font size, a line height and tracking. `tailwind-merge` only knows Tailwind's own
 * utilities, so without this it keeps `text-sm` beside `type-body` and the stylesheet's order picks
 * `text-sm`. Registered as font sizes, a `type-*` given later replaces an earlier `text-*` size, and
 * drops the `leading-*` that came with it.
 */
export const TYPE_SCALE_CLASSES = [
  "type-display",
  "type-nav",
  "type-body",
  "type-sub",
  "type-caption",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { type: TYPE_SCALE_CLASSES.map((name) => name.slice("type-".length)) },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
