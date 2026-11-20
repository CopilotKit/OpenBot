import { createReactComponent } from "@tabler/icons-react";

/*
 * Two of OpenDuet's glyphs have no Tabler twin, and they are the two a person sees on every screen:
 * the menu (two long lines over a short one) and the Tasks tab (a box, a check, three lines). They
 * are made as Tabler icons, on Tabler's 24-unit grid with its round caps and props, so they sit in
 * a row of Tabler icons at the same weight. Everything else in the skin is Tabler's own.
 */

export const IconMenuShort = createReactComponent(
  "outline",
  "menu-short",
  "MenuShort",
  [["path", { d: "M4 7h16M4 12h16M4 17h10", key: "menu-short-lines" }]],
);

export const IconTasksList = createReactComponent(
  "outline",
  "tasks-list",
  "TasksList",
  [
    [
      "rect",
      {
        x: "3",
        y: "4",
        width: "6",
        height: "6",
        rx: "1.5",
        key: "tasks-list-box",
      },
    ],
    [
      "path",
      {
        d: "m3 17 2 2 4-4M13 5h8M13 12h8M13 19h8",
        key: "tasks-list-lines",
      },
    ],
  ],
);
