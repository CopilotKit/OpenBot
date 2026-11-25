import { twMerge } from "tailwind-merge";

/** Joins class names, the later one winning where two set the same thing, as the web app's `cn`. */
export function cn(...classes: (string | false | null | undefined)[]) {
  return twMerge(classes.filter(Boolean).join(" "));
}
