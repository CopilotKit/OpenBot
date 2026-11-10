import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { RETIRED_PAGE_NAMES } from "../app/src/lib/primitives";

/**
 * Guard: no page, menu entry or settings row is titled with a name OpenBot has retired. A person
 * learns one noun, Bot, and eight things a Bot has (docs/how-openbot-works.md); a second name for
 * one of them sends them looking for a second place.
 *
 * Read, in the app and every skin:
 * - the `title` of a `PageShell` or a `BotSubpage`, every string the attribute can evaluate to;
 * - the text of an `ItemTitle`, which is how a settings row is titled;
 * - in the files that list where a person can go (the main menu, the Settings and Admin sidebars, a
 *   Bot's settings rows, `managePaths` and anything under `skins/`), every `title`, `label` and
 *   `…Label` property whose value is a string.
 *
 * Only whole titles are compared, case aside. "Automatic learning" passes where "Learning" fails,
 * and sentences are never read: "goal" and "check-in" remain ordinary words.
 */

const REPO = join(import.meta.dir, "..");
const APP = join(REPO, "app/src");

const RETIRED = new Map(
  RETIRED_PAGE_NAMES.map((entry) => [entry.name.toLowerCase(), entry]),
);

/** Elements whose `title` is a page title. */
const PAGE_TITLED = new Set(["PageShell", "BotSubpage"]);

/** Files, relative to app/src, that list destinations. Anything under `skins/` is one too. */
const DESTINATION_LISTS = new Set([
  "lib/navigation.ts",
  "lib/manage-paths.ts",
  "lib/primitives.ts",
  "components/settings/settings-sidebar.tsx",
  "components/admin/admin-sidebar.tsx",
  "components/admin/admin-sections.ts",
  "components/bot-profile/settings-rows.tsx",
]);

function* files(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", "generated"].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (
      /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$|\.gen\.ts$|\.d\.ts$/.test(name)
    )
      yield path;
  }
}

/** Every string an expression can evaluate to: literals, both arms of a ternary, `a ?? "b"`. */
function strings(node: ts.Node): ts.StringLiteralLike[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node];
  const found: ts.StringLiteralLike[] = [];
  node.forEachChild((child) => {
    // A call's arguments are not what the attribute evaluates to.
    if (ts.isCallExpression(node) && child !== node.expression) return;
    found.push(...strings(child));
  });
  return found;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function propertyName(node: ts.PropertyAssignment): string | null {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
    ? node.name.text
    : null;
}

/** Every retired title in one file, as `file:line  "Title" (now: …)`. */
function retiredTitles(path: string, listsDestinations: boolean) {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const check = (title: string, at: ts.Node) => {
    const entry = RETIRED.get(title.trim().toLowerCase());
    if (!entry) return;
    const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line;
    found.push(
      `${relative(REPO, path)}:${line + 1}  "${title.trim()}" (now: ${entry.now})`,
    );
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      PAGE_TITLED.has(tagName(node))
    ) {
      for (const attribute of node.attributes.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText() === "title" &&
          attribute.initializer
        ) {
          for (const literal of strings(attribute.initializer))
            check(literal.text, literal);
        }
      }
    }
    if (ts.isJsxElement(node) && tagName(node.openingElement) === "ItemTitle") {
      const said = node.children
        .filter(ts.isJsxText)
        .map((child) => child.text)
        .join("");
      if (said.trim()) check(said, node);
    }
    if (listsDestinations && ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      if (name && /^(title|label|\w+Label)$/.test(name)) {
        for (const literal of strings(node.initializer))
          check(literal.text, literal);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function scan(): string[] {
  return [...files(APP)].flatMap((path) => {
    const inApp = relative(APP, path).split("\\").join("/");
    return retiredTitles(
      path,
      DESTINATION_LISTS.has(inApp) || inApp.startsWith("skins/"),
    );
  });
}

test("no page, menu entry or settings row is titled with a retired name", () => {
  const found = scan().filter(
    // The list of retired names is not a title.
    (hit) => !hit.startsWith("app/src/lib/primitives.ts:"),
  );
  expect(found).toEqual([]);
});

test("the scan finds what it is for", () => {
  // A scanner that finds nothing passes every tree.
  const sample = join(import.meta.dir, "fixtures/retired-page-names/page.tsx");
  const found = retiredTitles(sample, true).map((hit) =>
    hit.replace(/^.*?\d+ {2}/, ""),
  );
  expect(found).toEqual([
    '"Capabilities" (now: Skills, or Memory)',
    '"Goals" (now: Routines)',
    '"What it can do" (now: Skills, Apps, Approvals)',
    '"Saved logins" (now: Vault)',
  ]);
});
