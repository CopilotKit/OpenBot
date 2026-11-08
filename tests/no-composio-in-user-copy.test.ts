import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: no text a person reads names Composio. A person connects their work apps through OpenBot,
 * and the company OpenBot connects through is never named on a screen, the admin's included (see
 * .claude/skills/openbot-copy).
 *
 * Read are the string literals, template text and JSX text of the desktop window, the app, the
 * Recorder extension and the shared modules both sides render, the string literals of the
 * desktop's native side, and the server's plugin routes and plugin store, which write every
 * sentence the plugin routes send to the browser. A template that interpolates the broker's
 * display name (`BROKERED_PROFILE[…].vendor`, `activeVendor`) counts as naming it.
 *
 * Not read: code identifiers, ids and env names (`composio-hubspot`, `COMPOSIO_API_KEY`; the check
 * is for the capitalised word), type-level strings, comments, tests, log calls, and docs/ and
 * charts/, which operators read to configure Composio by name. The broker client's own sentences
 * (server/src/plugins/composio*) are written for the operator; the routes a person calls pass them
 * through `forPerson` (server/src/plugins/route-groups/context.ts), and
 * server/tests/plugin-routes.test.ts pins that a person never reads one.
 */
const REPO = join(import.meta.dir, "..");
const WORD = /\bComposio\b/;
/** An interpolation of the broker's display name. */
const VENDOR_NAME =
  /^(BROKERED_PROFILE\[[^\]]+\]\.vendor|activeVendor|profile\.vendor|vendor)$/;

/** Calls whose arguments are written to a log, never shown. */
const LOGGING =
  /^(console\.\w+|log|logger\.\w+|this\.log|options\.log|note|once|sayUnavailable)$/;

function* files(directory: string, source: RegExp): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", "target", "tests", "gen"].includes(name))
      continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path, source);
    else if (source.test(name) && !/\.test\.tsx?$|_tests\.rs$/.test(name))
      yield path;
  }
}

/** Written to a log, or part of a type or an import: never shown. */
function unshown(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isCallExpression(at) && LOGGING.test(at.expression.getText()))
      return true;
    if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return true;
    if (ts.isTypeNode(at)) return true;
  }
  return false;
}

/** Every piece of text in a TypeScript file that names Composio, as `file:line  text`. */
function scriptText(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const at = (node: ts.Node, said: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    found.push(`${relative(REPO, path)}:${line + 1}  ${said.trim()}`);
  };
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
    if (said !== null && WORD.test(said) && !unshown(node)) at(node, said);
    if (
      ts.isTemplateSpan(node) &&
      VENDOR_NAME.test(node.expression.getText(file)) &&
      !unshown(node)
    )
      at(node, `\${${node.expression.getText(file)}}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every string literal in a Rust file's own code that names Composio. Comments and every
 * `#[cfg(test)] mod … { … }` block are passed over, and a literal inside `eprintln!` or `println!`
 * is a log line.
 */
function nativeText(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const found: string[] = [];
  // Strings, comments and braces in one pass, so neither a `//` nor a brace inside a string counts.
  const token =
    /#\[cfg\(test\)\]\s*mod \w+\s*\{|(?<!\w)b?r(#*)"[\s\S]*?"\1|"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])'|[{}]/g;
  let depth = 0;
  // The depth a test module opened at, while inside one.
  let tests: number | null = null;
  for (const match of text.matchAll(token)) {
    const literal = match[0];
    if (literal.startsWith("#")) {
      tests ??= depth;
      depth += 1;
      continue;
    }
    if (literal === "{") depth += 1;
    if (literal === "}") {
      depth -= 1;
      if (depth === tests) tests = null;
    }
    if (tests !== null || !/^b?r?#*"/.test(literal)) continue;
    if (!WORD.test(literal)) continue;
    const before = text.slice(0, match.index);
    const statement = before.slice(
      Math.max(
        before.lastIndexOf(";"),
        before.lastIndexOf("{"),
        before.lastIndexOf("}"),
      ),
    );
    if (/\b(e?println|eprint|print|debug_assert\w*)!\s*\(/.test(statement))
      continue;
    const line = before.split("\n").length;
    found.push(
      `${relative(REPO, path)}:${line}  ${literal.replace(/\\\n\s*/g, "")}`,
    );
  }
  return found;
}

function shown(): string[] {
  const found = [
    ...[
      "desktop/src",
      "app/src",
      "extension/src",
      "shared",
      "server/src/plugins/route-groups",
      "server/src/plugins/plugin-store",
    ].flatMap((root) => [...files(join(REPO, root), /\.tsx?$/)]),
  ].flatMap(scriptText);
  found.push(
    ...[...files(join(REPO, "desktop/src-tauri/src"), /\.rs$/)].flatMap(
      nativeText,
    ),
  );
  return found;
}

test("no text a person reads in the desktop app, the app or the plugin routes says Composio", () => {
  expect(shown()).toEqual([]);
});

test("the scan finds what it is for", () => {
  // A scanner that finds nothing passes every tree. These are shown, so each must be caught.
  const sample = join(import.meta.dir, "fixtures", "composio-copy");
  expect(scriptText(join(sample, "shown.tsx")).length).toBe(5);
  expect(scriptText(join(sample, "logged.ts"))).toEqual([]);
});
