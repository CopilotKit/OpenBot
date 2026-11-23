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

function regionLines(mode: Mode, entries: string, indent: string) {
  const names = entries.trim() === "all" ? TOKENS : entries.trim().split(/\s+/);
  return names.map((entry) => {
    const [field, name] = entry.includes("=")
      ? entry.split("=")
      : [undefined, entry];
    const value = scheme[mode][token(name as string)];
    if (!field) return `${indent}--${name}: ${value};`;
    const { r, g, b } = oklchToRgb(value);
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

const WHOLE: Record<(typeof WHOLE_FILES)[number], () => string> = {
  "mobile/src/scheme.ts": mobileScheme,
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
