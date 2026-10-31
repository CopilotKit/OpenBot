import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cn, TYPE_SCALE_CLASSES } from "../src/lib/utils";

/**
 * OpenBot's visual system, carried by the variables every screen already reads, so these
 * tests read the stylesheet itself: every variable has a value in both themes, the colours that
 * carry words clear their contrast floor on the grounds they sit on, and the type scale is five
 * sizes in rem. That is `theme.css`, which the app and the Recorder's pages both import.
 */

const styles = readFileSync(
  new URL("../src/theme.css", import.meta.url),
  "utf8",
);

/** The custom properties declared directly inside the first block that opens with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = styles.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  let depth = 0;
  let end = start;
  for (let at = styles.indexOf("{", start); at < styles.length; at++) {
    if (styles[at] === "{") depth++;
    if (styles[at] === "}") depth--;
    if (depth === 0) {
      end = at;
      break;
    }
  }
  const body = styles.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const variables = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    variables.set(
      match[1] as string,
      (match[2] as string).replace(/\s+/g, " "),
    );
  }
  return variables;
}

const light = block(":root");
const dark = block(".dark");

/** A variable's value, following `var(--x)` within the same theme. */
function resolve(theme: Map<string, string>, name: string): string {
  const fallback = theme === dark ? light : undefined;
  let value = theme.get(name) ?? fallback?.get(name);
  for (let hops = 0; value?.startsWith("var(") && hops < 5; hops++) {
    const inner = value.slice(4, -1);
    value = theme.get(inner) ?? fallback?.get(inner);
  }
  if (!value) throw new Error(`${name} has no value`);
  return value;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`${hex} is not #rrggbb`);
  const channels = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const themes = [
  ["light", light],
  ["dark", dark],
] as const;

describe("light and dark", () => {
  test("every variable the light theme defines has a dark value", () => {
    const aliases = [...light.entries()]
      .filter(([, value]) => value.startsWith("var(--"))
      .map(([name]) => name);
    const missing = [...light.keys()].filter(
      (name) =>
        !dark.has(name) &&
        !aliases.includes(name) &&
        // Shape and motion are the same in both themes.
        !/^--(radius|target|ease|dur)/.test(name),
    );
    expect(missing).toEqual([]);
    for (const name of ["--glass", "--veil", "--shadow-glass"])
      expect(dark.has(name)).toBe(true);
  });

  test("the visual system's roles arrive under their own names", () => {
    const roles = [
      "--brand",
      "--brand-foreground",
      ...["done", "needs", "working", "problem"].flatMap((status) => [
        `--status-${status}`,
        `--status-${status}-soft`,
      ]),
      "--glass",
      "--veil",
      "--shadow-float",
      "--shadow-card",
      "--shadow-raised",
      "--shadow-glass",
      "--ease-out",
      "--ease-in",
      "--dur-tap",
      "--dur-swap",
      "--dur-enter",
      "--dur-sheet",
    ];
    expect(roles.filter((name) => !light.has(name))).toEqual([]);
    expect(light.get("--target")).toBe("44px");
    expect(light.get("--radius")).toBe("0.55rem");
    expect(styles).not.toContain("--duet-");
  });

  test("the brand is for focus, selection and links; shadcn's accent stays a neutral fill", () => {
    for (const [, theme] of themes) {
      expect(resolve(theme, "--ring")).toBe(resolve(theme, "--brand"));
      expect(resolve(theme, "--sidebar-primary")).toBe(
        resolve(theme, "--brand"),
      );
      expect(resolve(theme, "--accent")).toBe(resolve(theme, "--secondary"));
    }
  });
});

describe("contrast, checked in both themes", () => {
  const grounds = [
    "--background",
    "--card",
    "--popover",
    "--secondary",
    "--muted",
    "--accent",
    "--sidebar",
    "--sidebar-accent",
  ];
  for (const [themeName, theme] of themes) {
    test(`text roles clear 4.5:1 on every ground, ${themeName}`, () => {
      for (const ink of [
        "--foreground",
        "--muted-foreground",
        "--card-foreground",
        "--popover-foreground",
        "--secondary-foreground",
        "--accent-foreground",
        "--sidebar-foreground",
        "--sidebar-accent-foreground",
        "--brand",
        "--destructive",
        "--success",
        "--status-done",
        "--status-needs",
        "--status-working",
        "--status-problem",
      ])
        for (const ground of grounds)
          expect({
            ink,
            ground,
            clears:
              contrast(resolve(theme, ink), resolve(theme, ground)) >= 4.5,
          }).toEqual({ ink, ground, clears: true });
    });

    test(`each status word clears 4.5:1 on its own soft fill, ${themeName}`, () => {
      for (const status of ["done", "needs", "working", "problem"])
        expect({
          status,
          ratio:
            contrast(
              resolve(theme, `--status-${status}`),
              resolve(theme, `--status-${status}-soft`),
            ) >= 4.5,
        }).toEqual({ status, ratio: true });
    });
  }

  test("what sits on the primary clears 4.5:1", () => {
    for (const [themeName, theme] of themes)
      for (const [on, fill] of [
        ["--primary-foreground", "--primary"],
        ["--brand-foreground", "--brand"],
        ["--sidebar-primary-foreground", "--sidebar-primary"],
      ])
        expect({
          themeName,
          on,
          clears:
            contrast(
              resolve(theme, on as string),
              resolve(theme, fill as string),
            ) >= 4.5,
        }).toEqual({ themeName, on, clears: true });
  });
});

describe("the type scale", () => {
  const rules = styles.replace(/\/\*[\s\S]*?\*\//g, "");

  test("the root font size is the browser's", () => {
    expect(rules).not.toMatch(/html\s*\{\s*font-size/);
    // OpenBot's 15px scale is gone: no `text-*` size is redefined, and body text is not pinned.
    expect(rules).not.toMatch(/--text-[\w-]+\s*:/);
    expect(rules).not.toMatch(/body\s*\{[^}]*@apply[^;]*\btext-base\b/);
  });

  test("five sizes, in rem", () => {
    const sizes = new Map<string, string>();
    for (const match of styles.matchAll(
      /@utility (type-[\w-]+)\s*\{\s*font-size:\s*([^;]+);/g,
    ))
      sizes.set(match[1] as string, match[2] as string);
    expect(Object.fromEntries(sizes)).toEqual({
      "type-display": "1.5rem",
      "type-nav": "1.125rem",
      "type-body": "1.0625rem",
      "type-sub": "0.9375rem",
      "type-caption": "0.8125rem",
    });
  });

  test("Inter's single-storey a and flat-topped 3 are on for every screen", () => {
    expect(rules).toMatch(
      /@utility face\s*\{\s*font-feature-settings:\s*"cv11",\s*"ss03";/,
    );
    expect(rules).toMatch(/body\s*\{[^}]*@apply[^;]*\bface\b/);
  });
});

describe("merging classes", () => {
  test("a type size given later replaces a primitive's text size and leading", () => {
    for (const size of TYPE_SCALE_CLASSES)
      expect(cn("px-3 text-sm leading-relaxed", size)).toBe(`px-3 ${size}`);
    expect(cn("text-base font-medium", "type-display font-semibold")).toBe(
      "type-display font-semibold",
    );
  });

  test("a colour does not knock out a type size", () => {
    expect(cn("type-sub text-muted-foreground", "text-foreground")).toBe(
      "type-sub text-foreground",
    );
  });

  test("every type utility in the stylesheet is known to the merge", () => {
    const declared = [...styles.matchAll(/@utility (type-[\w-]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(declared)).toEqual(new Set(TYPE_SCALE_CLASSES));
  });
});
