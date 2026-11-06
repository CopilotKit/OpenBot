import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: no text a person reads names Intelligence. To a person it is all OpenBot, and the part of
 * OpenBot they mean is the back end (see .claude/skills/openbot-copy).
 *
 * Read are the string literals, template text and JSX text of the desktop window, the app, the
 * server, the Recorder extension and the shared Recorder disclosure, and the string literals of the
 * desktop's native side, whose problems, notices, progress lines and menu items reach the window and
 * the tray.
 * Not read: code identifiers and env names (`intelligenceStack`, `INTELLIGENCE_API_URL`; the check
 * is for the capitalised word), comments, tests, log calls, and docs/ and charts/, which operators
 * read to configure Intelligence by name.
 */
const REPO = join(import.meta.dir, "..");
const WORD = /\bIntelligence\b/;

/**
 * Text that names Intelligence and never reaches a person: written only to the server's log, or
 * refused before the server serves anything. Each entry must still match, so one that goes stale
 * is removed rather than kept as a hole.
 */
const NOT_SHOWN: { file: string; text: string; why: string }[] = [
  {
    file: "server/src/config.ts",
    text: "CopilotKit Intelligence is required and is not configured",
    why: "a boot refusal, printed to the operator's terminal before the server listens",
  },
  {
    file: "server/src/config.ts",
    text: "both say where the browser reaches the Intelligence gateway",
    why: "a boot refusal, printed before the server listens",
  },
  {
    file: "server/src/config.ts",
    text: "must be the Intelligence project's numeric ID",
    why: "a boot refusal, printed before the server listens",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence has no valid licence. Give Intelligence's own deployment",
    why: "the boot log's advice, which names the Helm keys an operator sets",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence's licence has expired. Renew it and replace COPILOTKIT_LICENSE_TOKEN",
    why: "the boot log's advice",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Managed Intelligence could not resolve this project's entitlement",
    why: "the boot log's advice",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence answers that this deployment's entitlement is not active",
    why: "the boot log's advice",
  },
  {
    file: "server/src/intelligence-entitlement-check.ts",
    text: "Intelligence did not confirm this deployment's entitlement",
    why: "the boot log's advice",
  },
];

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

function logged(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isCallExpression(at) && LOGGING.test(at.expression.getText()))
      return true;
    if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return true;
  }
  return false;
}

/** Every piece of text in a TypeScript file that names Intelligence, as `file:line  text`. */
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
    if (said !== null && WORD.test(said) && !logged(node)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      found.push(`${relative(REPO, path)}:${line + 1}  ${said.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every string literal in a Rust file's own code that names Intelligence. Comments and every
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
    ...["desktop/src", "app/src", "server/src", "extension/src"].flatMap(
      (root) => [...files(join(REPO, root), /\.tsx?$/)],
    ),
    join(REPO, "shared/recorder-disclosure.ts"),
  ].flatMap(scriptText);
  found.push(
    ...[...files(join(REPO, "desktop/src-tauri/src"), /\.rs$/)].flatMap(
      nativeText,
    ),
  );
  return found;
}

const isNotShown = (hit: string) =>
  NOT_SHOWN.some(
    (entry) => hit.startsWith(`${entry.file}:`) && hit.includes(entry.text),
  );

test("no text a person reads in the desktop app, the app, the server or the Recorder says Intelligence", () => {
  expect(shown().filter((hit) => !isNotShown(hit))).toEqual([]);
});

test("every exception for text that is never shown still matches", () => {
  const found = shown();
  const stale = NOT_SHOWN.filter(
    (entry) =>
      !found.some(
        (hit) => hit.startsWith(`${entry.file}:`) && hit.includes(entry.text),
      ),
  );
  expect(stale).toEqual([]);
});

test("the scan finds what it is for", () => {
  // A scanner that finds nothing passes every tree. These are shown, so each must be caught.
  const sample = join(import.meta.dir, "fixtures", "intelligence-copy");
  expect(scriptText(join(sample, "shown.tsx")).length).toBe(4);
  expect(scriptText(join(sample, "logged.ts"))).toEqual([]);
  expect(nativeText(join(sample, "native.rs")).length).toBe(2);
});
