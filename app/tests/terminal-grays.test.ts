import { expect, test } from "bun:test";
import {
  TERMINAL_TEXT,
  TERMINAL_THEME,
} from "../src/components/computer/terminal-theme";

/** The hue, in degrees, of an sRGB hex color in oklch. */
function hue(hex: string) {
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = [1, 3, 5].map((i) =>
    lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

test("the terminal's grays are the app's dark blue-gray, not the old violet", () => {
  const grays = {
    background: TERMINAL_THEME.background,
    black: TERMINAL_THEME.black,
    brightBlack: TERMINAL_THEME.brightBlack,
    white: TERMINAL_THEME.white,
    foreground: TERMINAL_THEME.foreground,
    muted: TERMINAL_TEXT.muted,
  } as Record<string, string>;
  // The app's dark grays sit at hue 252; a hex rounds a faint tint's hue by a few degrees.
  const off = Object.entries(grays).filter(
    ([, hex]) => Math.abs(hue(hex) - 252) > 15,
  );
  expect(off).toEqual([]);
});
