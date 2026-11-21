import { defineIcon, GLYPH_STROKE } from "@/components/icons";

/*
 * Two of OpenDuet's glyphs have no twin in the icon set, and they are the two a person sees on every
 * screen: the menu (two long lines over a short one) and the Tasks tab (a box, a check, three lines).
 * They are drawn on the set's 24-unit grid with its round caps and stroke, so they sit in a row of
 * the set's icons at the same weight. Everything else in the skin is the set's own.
 */

export const IconMenuShort = defineIcon("menu-short", [
  ["path", { d: "M4 7h16M4 12h16M4 17h10", key: "lines", ...GLYPH_STROKE }],
]);

export const IconTasksList = defineIcon("tasks-list", [
  [
    "rect",
    {
      x: "3",
      y: "4",
      width: "6",
      height: "6",
      rx: "1.5",
      key: "box",
      ...GLYPH_STROKE,
    },
  ],
  [
    "path",
    {
      d: "m3 17 2 2 4-4M13 5h8M13 12h8M13 19h8",
      key: "lines",
      ...GLYPH_STROKE,
    },
  ],
]);
