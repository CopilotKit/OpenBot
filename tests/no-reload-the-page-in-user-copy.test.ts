import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: no text a person reads in the app tells them to reload the page. The same screens are
 * shown in a browser and in the OpenBot Desktop window, and the Desktop window has no reload
 * button and no address bar. A failure says what failed and one next step that works in both:
 * "Try again in a moment." (see .claude/skills/openbot-copy).
 *
 * Read are the string literals, template text and JSX text under app/src. Not read: comments,
 * code identifiers, tests, and the word "Reload" on its own, which is the name of the button that
 * reloads the page a Bot has open in its own browser.
 */
const REPO = join(import.meta.dir, "..");
const SAYS_RELOAD = /\breload(ing)?\s+(the|this)\s+page\b/i;

/** Being reworded with the organizations work, which changes this file at the same time. */
const REWORDED_ELSEWHERE = new Set(["app/src/lib/organizations/queries.ts"]);

function* files(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", "generated"].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

/** Every piece of text in a file that tells a person to reload the page, as `file:line  text`. */
export function sayingReload(path: string, text: string): string[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const said =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
        ? node.text
        : null;
    if (said !== null && SAYS_RELOAD.test(said)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      found.push(
        `${relative(REPO, path)}:${line + 1}  ${said.replace(/\s+/g, " ").trim()}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("no text a person reads in the app tells them to reload the page", () => {
  const found = [...files(join(REPO, "app/src"))]
    .filter((path) => !REWORDED_ELSEWHERE.has(relative(REPO, path)))
    .flatMap((path) => sayingReload(path, readFileSync(path, "utf8")));
  expect(found).toEqual([]);
});

test("the scan finds what it is for, across a line break, and passes over comments", () => {
  const sample = [
    'const a = "Couldn\'t load your Bots. Reload the page.";',
    "const b = <p>Couldn't load this app. Reload the",
    "  page, or ask an admin.</p>;",
    "// Reload the page in a comment is not shown.",
    'const c = <button aria-label="Reload" />;',
  ].join("\n");
  expect(sayingReload(join(REPO, "sample.tsx"), sample)).toEqual([
    "sample.tsx:1  Couldn't load your Bots. Reload the page.",
    "sample.tsx:2  Couldn't load this app. Reload the page, or ask an admin.",
  ]);
});
