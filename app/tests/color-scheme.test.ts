import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Every OpenBot app draws with one color scheme, the tokens in theme.css, and with few colors
 * (docs/app-guidelines.md). A class from Tailwind's own palette (`text-amber-600`, `bg-blue-500`)
 * is a color outside the scheme: it has no dark value of its own, a skin or a customer's theme
 * can't change it, and one more of them is how a screen drifts into its own look.
 */

const SRC = new URL("../src/", import.meta.url).pathname;

const PALETTE =
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|caret|placeholder|accent)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}(?![\w-])/g;

/** Every .ts and .tsx file under app/src, relative to it. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [relative(SRC, path)] : [];
  });
}

const uses = new Map<string, string[]>();
for (const file of sourceFiles()) {
  const found = [...readFileSync(join(SRC, file), "utf8").matchAll(PALETTE)];
  if (found.length)
    uses.set(
      file,
      found.map((match) => match[0]),
    );
}

/*
 * The files that drew with the palette before this rule, as they were. The list only gets shorter:
 * move a file's colors to tokens and take it off. Nothing is added to it. A color the scheme
 * lacks is a change to theme.css first.
 */
const NOT_YET_ON_THE_SCHEME = new Set([
  "components/app-sidebar/channel-item-content.tsx",
  "components/browser/recording.tsx",
  "components/channels/coding-tool-cards.tsx",
  "components/channels/voice-call-widget.tsx",
  "components/component-preview.tsx",
  "components/computer/computer-view.tsx",
  "components/gallery/frame.tsx",
  "components/onboarding/demos/team-demo.tsx",
  "components/onboarding/demos/welcome-demo.tsx",
  "components/onboarding/laptop-illustration.tsx",
  "components/onboarding/organization-flow.tsx",
  "components/routines/routine-runs.tsx",
]);

describe("one color scheme", () => {
  test("warning and success are drawn with their tokens, never amber or green", () => {
    const greensAndAmbers = [...uses].flatMap(([file, classes]) =>
      classes
        .filter((name) => /-(amber|yellow|lime|green|emerald)-/.test(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(greensAndAmbers).toEqual([]);
  });

  test("no file starts drawing with Tailwind's palette", () => {
    const newcomers = [...uses.keys()].filter(
      (file) => !NOT_YET_ON_THE_SCHEME.has(file),
    );
    expect(newcomers).toEqual([]);
  });

  test("a file moved to the scheme comes off the list", () => {
    const moved = [...NOT_YET_ON_THE_SCHEME].filter((file) => !uses.has(file));
    expect(moved).toEqual([]);
  });
});
