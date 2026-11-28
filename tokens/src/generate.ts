import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oklchToHex, oklchToRgb } from "./color";
import { MEANING, type Mode, scheme, TOKENS, type Token } from "./scheme";
import { REGIONS, WHOLE_FILES } from "./targets";

/**
 * What every copy of the scheme should hold, worked out from scheme.ts. `bun run tokens:generate`
 * writes it, and tokens/tests/generated.test.ts compares it with what is checked in.
 *
 * A copy is either a whole file the generator owns, or a region inside a hand-written file,
 * between two marker comments:
 *
 *   / * tokens/src/scheme.ts, light: background foreground card (bun run tokens:generate) * /
 *   --background: oklch(...);
 *   ...
 *   / * end of tokens/src/scheme.ts * /
 *
 * `all` names every token. An entry written `field=token` writes a Rust struct field holding the
 * token as an RGB tuple, for the desktop app's native first paint; otherwise a line is a CSS custom
 * property. The region keeps the start marker's indent.
 */

const START =
  /tokens\/src\/scheme\.ts, (light|dark): (.+?) \(bun run tokens:generate\)/;
const END = /end of tokens\/src\/scheme\.ts/;

function token(name: string): Token {
  if (!(name in MEANING))
    throw new Error(`not a token in tokens/src/scheme.ts: ${name}`);
  return name as Token;
}

/**
 * A color as an RGB copy can hold it, which has no opacity: a translucent one (a line drawn as the
 * text color at 12%) is blended over the mode's `card`, the surface it is drawn on there, rather
 * than written at full strength.
 */
function opaque(mode: Mode, value: string) {
  const color = oklchToRgb(value);
  if (color.alpha === 1) return color;
  const under = oklchToRgb(scheme[mode].card);
  const blend = (top: number, below: number) =>
    Math.round(top * color.alpha + below * (1 - color.alpha));
  return {
    r: blend(color.r, under.r),
    g: blend(color.g, under.g),
    b: blend(color.b, under.b),
  };
}

function regionLines(mode: Mode, entries: string, indent: string) {
  const names = entries.trim() === "all" ? TOKENS : entries.trim().split(/\s+/);
  return names.map((entry) => {
    const [field, name] = entry.includes("=")
      ? entry.split("=")
      : [undefined, entry];
    const value = scheme[mode][token(name as string)];
    if (!field) return `${indent}--${name}: ${value};`;
    const { r, g, b } = opaque(mode, value);
    const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;
    return `${indent}${field}: (${hex(r)}, ${hex(g)}, ${hex(b)}),`;
  });
}

/** A hand-written file with each of its regions filled from the scheme. */
export function fillRegions(text: string, file: string) {
  const lines = text.split("\n");
  const out: string[] = [];
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    out.push(line);
    const start = START.exec(line);
    if (!start) continue;
    const end = lines.findIndex((next, j) => j > i && END.test(next));
    if (end < 0)
      throw new Error(
        `${file}: a tokens region at line ${i + 1} has no end marker`,
      );
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    out.push(...regionLines(start[1] as Mode, start[2] as string, indent));
    out.push(lines[end] as string);
    i = end;
    found++;
  }
  if (!found) throw new Error(`${file}: no tokens region`);
  return out.join("\n");
}

/** The phone app's copy: hex, since React Native draws no `oklch()`. */
function mobileScheme() {
  const palette = (mode: Mode) =>
    TOKENS.map(
      (name) =>
        // Quoted only where it must be, as the formatter writes it.
        `    ${/^[a-z]+$/.test(name) ? name : JSON.stringify(name)}: "${oklchToHex(scheme[mode][name])}",`,
    ).join("\n");
  return `// Written by \`bun run tokens:generate\` from tokens/src/scheme.ts. Don't edit it: change the scheme there.

/** OpenBot's color scheme, light and dark, in hex: React Native draws no \`oklch()\`. */
export const scheme = {
  light: {
${palette("light")}
  },
  dark: {
${palette("dark")}
  },
} as const;

export type Token = keyof typeof scheme.light;
`;
}

/**
 * The web app's manifest: its name and its icons (app/scripts/web-icons.ts writes them) for a
 * phone's home screen or an installed app, and the light page's ground for the colors a phone
 * paints around it. JSON has no comments, so it is written whole rather than as a region.
 */
function webManifest() {
  const background = oklchToHex(scheme.light.background);
  const icon = (size: number, maskable: boolean) => ({
    src: `/icon-${maskable ? "maskable-" : ""}${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
    ...(maskable ? { purpose: "maskable" } : {}),
  });
  /*
   * `display: standalone` makes OpenBot added to a phone's Home Screen an app of its own, which is
   * also what lets an iPhone or iPad give it push notifications (Settings, Notifications). `id` and
   * `scope` say it is one app, the whole of this address.
   */
  const manifest = {
    id: "/",
    name: "OpenBot",
    short_name: "OpenBot",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: background,
    theme_color: background,
    icons: [
      icon(192, false),
      icon(512, false),
      icon(192, true),
      icon(512, true),
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const WHOLE: Record<(typeof WHOLE_FILES)[number], () => string> = {
  "mobile/src/scheme.ts": mobileScheme,
  "app/public/manifest.webmanifest": webManifest,
};

/** Every generated file, by its path from the repository root, as it should be. */
export function generate(root: string) {
  const files = new Map<string, string>();
  for (const file of REGIONS) {
    files.set(file, fillRegions(readFileSync(join(root, file), "utf8"), file));
  }
  for (const file of WHOLE_FILES) files.set(file, WHOLE[file]());
  return files;
}
