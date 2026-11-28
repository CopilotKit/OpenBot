// Where the OS draws the window's own buttons over (or above) OpenBot Desktop's page, per OS, in the
// window's CSS pixels from its top left. One place for every number: WindowFrame draws the buttons
// here, and the Spacing check (spacing.ts) measures the page against the same boxes.
import type { Box } from "./geometry";

export type Os = "mac" | "windows";
export type Host = "desktop" | "browser";

/**
 * macOS: the close, minimise and zoom buttons over the page's top-left corner.
 *
 * - The window is built with `.traffic_light_position(TRAFFIC_LIGHTS)` and
 *   `TRAFFIC_LIGHTS = LogicalPosition { x: 20.0, y: 31.0 }` (desktop/src-tauri/src/main.rs,
 *   `build_main_window`), with `titleBarStyle: "Overlay"` for setup and for OpenBot's own page
 *   (`tauri.conf.json`, `match_title_bar`): the buttons over the page, which runs to the window's top
 *   edge, and no title text.
 * - tao 0.37.2 (the version in desktop/src-tauri/Cargo.lock), `inset_traffic_lights` in
 *   src/platform_impl/macos/view.rs, puts button `i`'s frame at `x + i * space_between`, where
 *   `space_between` is AppKit's own distance from the close button to the minimise button, and makes
 *   the title bar container `button height + y` tall; it does not move the buttons up or down in it.
 *   So the close button's frame starts 20 px in.
 * - AppKit's standard buttons are 12 px circles 20 px apart (8 px between them), each centred in a
 *   14 px wide frame: the first circle is 21 to 33 px in, its middle at 27.
 * - The middle of the circles lands about 1.5 px below `y` on macOS 26 (main.rs's measurement beside
 *   `TRAFFIC_LIGHTS`): 32.5 px down, so the circles run from 26.5 to 38.5 px.
 * - Checked against Dusty's capture of Settings → Connections (1252 px wide, the window's outer
 *   edge at x 55, y 37): the centres are at x 82, 103, 123 and y 70, so 27, 48, 68 and 33 from the
 *   window. Its scale is 1.0: the close button's middle (27 = 20 + 7) and the row's middle (33 ≈ 32.5)
 *   fall where the code above puts them at 1 capture px per window px, and the centres are 20.5 px
 *   apart against 20 (within the capture's 1 px rounding).
 */
export const MAC_BUTTONS = {
  /** `TRAFFIC_LIGHTS` in main.rs: where the close button's frame starts. */
  position: { x: 20, y: 31 },
  /** AppKit: the circles' size, and the room between two of them. */
  diameter: 12,
  gap: 8,
  /** The first circle's left edge: the 14 px frame's 1 px margin. */
  firstX: 21,
  /** The circles' middle: 1.5 px below `position.y` on macOS 26. */
  middleY: 32.5,
} as const;

/** Each of the three circles (close, minimise, zoom), left to right. */
export function macButtonCircles(): Box[] {
  const { diameter, gap, firstX, middleY } = MAC_BUTTONS;
  return [0, 1, 2].map((i) => ({
    x: firstX + i * (diameter + gap),
    y: middleY - diameter / 2,
    width: diameter,
    height: diameter,
  }));
}

/** The box around the three circles: 21 to 73 px in, 26.5 to 38.5 px down. */
export function macButtonsBox(): Box {
  const circles = macButtonCircles();
  const first = circles[0] as Box;
  const last = circles[2] as Box;
  return {
    x: first.x,
    y: first.y,
    width: last.x + last.width - first.x,
    height: first.height,
  };
}

/** Windows: the system's own title bar, 32 px tall, above the page (WindowFrame draws it). */
export const WINDOWS_TITLE_BAR_HEIGHT = 32;

/**
 * The window's buttons over the page, or null where nothing of the OS sits over it: Windows has its
 * own title bar above the page, and a browser draws none of these.
 */
export function windowButtonsBox(os: Os, host: Host = "desktop"): Box | null {
  if (host === "browser" || os !== "mac") return null;
  return macButtonsBox();
}
