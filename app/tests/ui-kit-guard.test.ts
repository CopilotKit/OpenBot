import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: screens are built from the UI Kit, not from looks of their own.
 *
 * The kit is the primitives in components/ui and the tokens in theme.css (Figma "OpenBot (MASTER)",
 * page UI Kit). A screen that writes `text-emerald-600`, `bg-[#f1f2f7]`, `rounded-[20px]` or
 * `shadow-[…]` draws a colour, a corner or a shadow the kit does not have, which no token change
 * reaches: the next redesign, a theme and the dark theme all pass it by. Use a token instead
 * (`text-success`, `bg-secondary`, `rounded-card`, `shadow-composer`) or a primitive that has the look.
 *
 * Icons come from components/icons only, which maps the app's names onto the free Hugeicons set;
 * the app has no Tabler dependency, so an import of it would also fail the build.
 *
 * Not read: components/ui and components/icons, which are the kit; skins/, whose alternate looks
 * are their own by design; tests; comments. Read: every other string under app/src, where class
 * names live.
 *
 * Screens drawn before the kit still have such classes. They are counted per file in
 * ui-kit-guard.baseline.json, and a count may only go down: a new one fails, and so does a cleanup
 * that leaves the baseline behind. After a cleanup, write the new counts with
 *
 *   OPENBOT_UPDATE_UI_KIT_BASELINE=1 bun test app/tests/ui-kit-guard.test.ts
 */
const APP = join(import.meta.dir, "..");
const SRC = join(APP, "src");
const BASELINE = join(import.meta.dir, "ui-kit-guard.baseline.json");
const NOT_READ = ["components/ui/", "components/icons/", "skins/"];

const COLOURED =
  "bg|text|border(?:-[trblxyse])?|ring|ring-offset|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|accent|caret|placeholder";
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/** What a screen may not draw for itself, each as a rule name and the classes it matches. */
export const RULES = {
  // Tailwind's own palette: `text-emerald-600`, `hover:bg-amber-500/10`.
  palette: new RegExp(
    `(?<![\\w-])(?:${COLOURED})-(?:${PALETTE})-\\d{2,3}(?:/\\d{1,3})?(?![\\w-])`,
    "g",
  ),
  // A colour written out: `bg-[#f1f2f7]`, `text-[rgb(…)]`. A token through var() is fine.
  colour: new RegExp(
    `(?<![\\w-])(?:${COLOURED})-\\[(?:#|rgba?\\(|hsla?\\(|oklch\\(|oklab\\()`,
    "g",
  ),
  // A corner of its own: `rounded-[20px]`, `rounded-t-[6px]`. `rounded-card` and the rest are the kit's.
  radius: /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[(?!var\()/g,
  // A shadow of its own: `shadow-[0_1px_2px_…]`. `shadow-composer` is the kit's.
  shadow: /(?<![\w-])shadow-\[(?!var\()/g,
} as const;
type Rule = keyof typeof RULES;
type Counts = Partial<Record<Rule, number>>;

function* files(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "generated"].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

function sourceOf(path: string, text: string) {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every class in a file's strings that a rule matches, by rule. Comments are not strings. */
export function offences(path: string, text: string): Record<Rule, string[]> {
  const found: Record<Rule, string[]> = {
    palette: [],
    colour: [],
    radius: [],
    shadow: [],
  };
  const visit = (node: ts.Node) => {
    const said =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
        ? node.text
        : null;
    if (said !== null) {
      for (const rule of Object.keys(RULES) as Rule[]) {
        found[rule].push(...(said.match(RULES[rule]) ?? []));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(path, text));
  return found;
}

/** The module each import in a file names. */
function importsOf(path: string, text: string): string[] {
  return sourceOf(path, text)
    .statements.filter(ts.isImportDeclaration)
    .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
}

function screens(): { path: string; text: string }[] {
  return [...files(SRC)]
    .map((path) => ({
      path: relative(SRC, path),
      text: readFileSync(path, "utf8"),
    }))
    .filter(({ path }) => !NOT_READ.some((dir) => path.startsWith(dir)));
}

function countAll(): Record<string, Counts> {
  const counts: Record<string, Counts> = {};
  for (const { path, text } of screens()) {
    const found = offences(path, text);
    for (const rule of Object.keys(found) as Rule[]) {
      if (found[rule].length > 0) {
        counts[path] ??= {};
        counts[path][rule] = found[rule].length;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

const updating = process.env.OPENBOT_UPDATE_UI_KIT_BASELINE === "1";

test("no file under app/src imports Tabler icons", () => {
  const tabler = [...files(SRC)].filter((path) =>
    importsOf(path, readFileSync(path, "utf8")).some((module) =>
      module.startsWith("@tabler/icons"),
    ),
  );
  expect(tabler.map((path) => relative(APP, path))).toEqual([]);
});

test("screens draw no colour, corner or shadow of their own beyond the baseline", () => {
  const counts = countAll();
  if (updating) {
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    return;
  }
  const baseline: Record<string, Counts> = JSON.parse(
    readFileSync(BASELINE, "utf8"),
  );
  const added: string[] = [];
  for (const [path, found] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(found) as [Rule, number][]) {
      const allowed = baseline[path]?.[rule] ?? 0;
      if (count > allowed) {
        const text = readFileSync(join(SRC, path), "utf8");
        const classes = [...new Set(offences(path, text)[rule])].join(" ");
        added.push(
          `app/src/${path}  ${rule} ${allowed} → ${count}: ${classes}`,
        );
      }
    }
  }
  // Each line is a class the kit does not have. Use a token or a components/ui primitive instead.
  expect(added).toEqual([]);
});

test("the baseline keeps up with every cleanup", () => {
  if (updating) return;
  const counts = countAll();
  const baseline: Record<string, Counts> = JSON.parse(
    readFileSync(BASELINE, "utf8"),
  );
  const behind: string[] = [];
  for (const [path, allowed] of Object.entries(baseline)) {
    for (const [rule, count] of Object.entries(allowed) as [Rule, number][]) {
      const now = counts[path]?.[rule] ?? 0;
      if (now < count)
        behind.push(`app/src/${path}  ${rule} ${count} → ${now}`);
    }
  }
  // Fewer than the baseline allows: run OPENBOT_UPDATE_UI_KIT_BASELINE=1 bun test app/tests/ui-kit-guard.test.ts
  expect(behind).toEqual([]);
});

test("the rules catch a screen's own looks and pass the kit's", () => {
  const sample = [
    'const a = "text-emerald-600 dark:text-emerald-400 hover:bg-amber-500/10";',
    // A template literal's parts are read too, on either side of what it interpolates.
    `const b = <div className={\`bg-[#f1f2f7] \${x} rounded-[20px]\`} />;`,
    'const c = cn("shadow-[0_1px_2px_rgb(0_0_0/0.05)]", "rounded-t-[6px]");',
    'const d = "bg-primary text-muted-foreground rounded-card shadow-composer rounded-full";',
    'const e = "bg-(--color-row-hover) rounded-[var(--radius)] text-[color:var(--x)]";',
    "// text-red-500 in a comment is not a class",
  ].join("\n");
  expect(offences("sample.tsx", sample)).toEqual({
    palette: ["text-emerald-600", "text-emerald-400", "bg-amber-500/10"],
    colour: ["bg-[#"],
    radius: ["rounded-[", "rounded-t-["],
    shadow: ["shadow-["],
  });
});
