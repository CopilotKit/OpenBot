import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Guard: what OpenBot Desktop says while it sets up, starts or updates, and when that stops, is in
 * plain words. A tester waited minutes on "Preparing the engine machine" and could not tell
 * whether setup was stuck, and a failure read "The back end's disk is nearly full. Podman has…".
 * The log keeps the technical parts; the screen says what happened and what to do. The Status
 * window, opened from the tray or the menu, is held to the same: it said "Back end" and "Container
 * engine" on a live Windows run. So is Settings > This computer in the app (`THIS_COMPUTER`), which
 * shows the same parts inside OpenBot Desktop.
 *
 * Read are the sentences of the desktop window (string literals, template text and JSX text with a
 * space in them, so identifiers and command names are not) and the native side's sentences that
 * reach it: a `Problem`'s headline, a setup row's line (`StepLine`), and the sentences
 * `explain_machine_error`, `missing_compose` and `said_about` choose. Not read: comments, tests,
 * log calls, Copy diagnostics (`SUPPORT`), a `Problem`'s detail and a `StepLine`'s `logged`
 * detail, which are the log's.
 */
const REPO = join(import.meta.dir, "..");

const TECHNICAL: RegExp[] = [
  /Podman/,
  /\bWSL\b/,
  /Windows Subsystem for Linux/,
  /engine machine/i,
  /\bengines?\b/i,
  /back[ -]?end/i,
  /front[ -]?end/i,
  /\bk3[sd]\b/i,
  /\bHelm\b/,
  /\bkubectl\b/,
  /\bCLI\b/,
  /\bCompose\b/,
  /\bcontainers?\b/i,
  /\brootful\b/,
  /\bcluster\b/i,
];

/**
 * Where a word stays: the person has to act in the product it names, or it is never shown. Each
 * entry must still be needed, so one that goes stale is removed rather than kept as a hole.
 */
const ALLOWED: { file: string; word: RegExp; why: string }[] = [
  {
    file: "desktop/src/WindowsBlocker.tsx",
    word: /\bWSL\b|Windows Subsystem for Linux/,
    why: "the Windows feature the person turns on, by the name Windows gives it",
  },
  {
    file: "desktop/src-tauri/src/windows.rs",
    word: /\bWSL\b|Windows Subsystem for Linux/,
    why: "the Windows blocker's own failures, about the feature the person turns on",
  },
  {
    file: "desktop/src-tauri/src/main.rs",
    word: /\bWSL\b|Windows Subsystem for Linux/,
    why: "the Windows blocker's fix failing, with the commands the person can run instead",
  },
  {
    file: "desktop/src/CopilotKitAccount.tsx",
    word: /Podman/,
    why: "the person switches to Docker Desktop or Podman",
  },
  {
    file: "desktop/src/localReadiness.ts",
    word: /Podman|\brootful\b/,
    why: "the Podman commands the person runs to give OpenBot more room or root",
  },
  {
    file: "desktop/src-tauri/src/install.rs",
    word: /Podman/,
    why: "the person installs Podman Desktop or the podman package, or asks IT to allow it, or sees the Podman they installed being updated",
  },
  {
    file: "desktop/src-tauri/src/engine_versions.rs",
    word: /Podman/,
    why: "the person updates or removes a Podman they installed, which OpenBot can't update for them, or is told the Podman OpenBot updated isn't answering",
  },
  {
    file: "desktop/src-tauri/src/own_machine.rs",
    word: /Podman/,
    why: "the person's own Podman, which OpenBot pauses on a Mac only once they say yes, and starts again on Quit",
  },
  {
    file: "desktop/src/PodmanGoAhead.tsx",
    word: /Podman/,
    why: "the person says yes to pausing their own Podman",
  },
  {
    file: "desktop/src/SetupProgress.tsx",
    word: /Podman/,
    why: "the rows for pausing the person's own Podman and starting it again",
  },
  {
    file: "desktop/src/ShuttingDown.tsx",
    word: /Podman/,
    why: "Quit starts the person's own Podman again",
  },
  {
    file: "desktop/src-tauri/src/acquire.rs",
    word: /\bCompose\b/,
    why: "the last resort: the person installs Compose v2 themselves",
  },
  {
    file: "desktop/src/ProviderPicker.tsx",
    word: /\bcontainers?\b/i,
    why: "an advanced field for a model the person hosts: the address OpenBot's containers use",
  },
  {
    file: "desktop/src/localEvalCli.ts",
    word: /back ?end/i,
    why: "the marker a native stop failure line starts with, matched and never the headline",
  },
];

/** Settings > This computer, and the names and messages it shows from the desktop app. */
const THIS_COMPUTER = [
  "app/src/routes/_authed/settings/this-computer.tsx",
  "app/src/lib/desktop/part-names.ts",
  "app/src/lib/desktop/mutations.ts",
  "app/src/lib/desktop/queries.ts",
];

/**
 * What goes to support and never to the screen: Copy diagnostics, in the Status window and on This
 * computer, which names the engine, the back end's stack and Docker's containers for whoever is
 * troubleshooting.
 */
const SUPPORT = /^diagnostics$/;

const LOGGING = /^(console\.\w+|log|logger\.\w+|this\.log|options\.log)$/;

function* files(directory: string, source: RegExp): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (
      ["node_modules", "dist", "target", "tests", "gen", "marks"].includes(name)
    )
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
    if (ts.isFunctionDeclaration(at) && SUPPORT.test(at.name?.text ?? ""))
      return true;
  }
  return false;
}

type Said = { file: string; line: number; text: string };

/** The window's sentences: text with a space in it, so not an identifier or a command name. */
function windowSentences(path: string): Said[] {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Said[] = [];
  const visit = (node: ts.Node) => {
    const said =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
        ? node.text.trim()
        : null;
    if (said && /\s/.test(said) && !logged(node)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      found.push({ file: relative(REPO, path), line: line + 1, text: said });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const LITERAL = String.raw`"(?:\\[\s\S]|[^"\\])*"`;

/** A Rust literal as the person reads it: line continuations joined, escapes undone. */
function unquote(literal: string): string {
  return literal
    .slice(1, -1)
    .replace(/\\\n\s*/g, "")
    .replace(/\\(["\\])/g, "$1");
}

/**
 * The native side's sentences that reach the window: a `Problem`'s headline, a setup row's line
 * (`StepLine`, `report_plain`, `report_running_plain`), and every literal in the functions that
 * choose a failure's headline. A row's other text goes to the log (`plain_row` in main.rs). Test
 * modules are cut off.
 */
function nativeSentences(path: string): Said[] {
  const whole = readFileSync(path, "utf8");
  const tests = whole.search(/\n#\[cfg\(test\)\]\s*\n\s*mod \w+\s*\{/);
  const text = tests === -1 ? whole : whole.slice(0, tests);
  const found: Said[] = [];
  const at = (index: number) => text.slice(0, index).split("\n").length;
  const headline = new RegExp(
    String.raw`(?:Problem::(?:plain|with)|StepLine::(?:here|elsewhere|asks))\(\s*(?:&?format!\(\s*)?(${LITERAL})|report_plain\(\s*&?[\w.]+,\s*"[\w-]+",\s*[\w.]+,\s*(${LITERAL})|report_running_plain\(\s*&?[\w.]+,\s*"[\w-]+",\s*(${LITERAL})`,
    "g",
  );
  for (const match of text.matchAll(headline))
    found.push({
      file: relative(REPO, path),
      line: at(match.index),
      text: unquote(match[1] ?? match[2] ?? match[3] ?? '""'),
    });
  for (const chooser of [
    "explain_machine_error",
    "missing_compose",
    "said_about",
  ]) {
    const start = text.search(new RegExp(String.raw`fn ${chooser}\(`));
    if (start === -1) continue;
    const end = text.indexOf("\n}\n", start);
    const body = text.slice(start, end);
    // A sentence starts with a capital; what a chooser matches the output against does not
    // ("pinging container registry", "without Podman user-mode networking").
    for (const match of body.matchAll(new RegExp(LITERAL, "g")))
      if (/^"[A-Z{]/.test(match[0]))
        found.push({
          file: relative(REPO, path),
          line: at(start + match.index),
          text: unquote(match[0]),
        });
  }
  return found;
}

function sentences(): Said[] {
  return [
    ...[...files(join(REPO, "desktop/src"), /\.tsx?$/)].flatMap(
      windowSentences,
    ),
    ...THIS_COMPUTER.map((path) => join(REPO, path)).flatMap(windowSentences),
    ...[...files(join(REPO, "desktop/src-tauri/src"), /\.rs$/)].flatMap(
      nativeSentences,
    ),
  ];
}

function technical(said: Said): string[] {
  return TECHNICAL.filter((word) => word.test(said.text))
    .filter(
      (word) =>
        !ALLOWED.some(
          (allowed) =>
            allowed.file === said.file &&
            allowed.word.test(said.text.match(word)?.[0] ?? ""),
        ),
    )
    .map(
      (word) =>
        `${said.file}:${said.line}  ${said.text.match(word)?.[0]}  in: ${said.text}`,
    );
}

test("what OpenBot Desktop says while it sets up, starts or updates, when that stops, on its Status window and on This computer, is plain words", () => {
  expect(sentences().flatMap(technical)).toEqual([]);
});

/**
 * The company alone. Product copy says OpenBot, and OpenBot by CopilotKit where the company has to
 * be named (see .claude/skills/openbot-copy). An address is not read: `github.com/CopilotKit/...`.
 */
const COMPANY_ALONE = /(?<!OpenBot\s+by\s+)(?<![\w/.-])CopilotKit(?![\w/-])/;

/** "by CopilotKit" in the lockup, where it follows OpenBot's name on screen (`Lockup`). */
const BESIDE_THE_NAME = (said: Said) =>
  said.file === "desktop/src/Sections.tsx" && said.text === "by CopilotKit";

test("OpenBot Desktop and This computer say OpenBot, or OpenBot by CopilotKit, never CopilotKit alone", () => {
  const all = sentences();
  expect(
    all
      .filter((said) => COMPANY_ALONE.test(said.text) && !BESIDE_THE_NAME(said))
      .map((said) => `${said.file}:${said.line}  ${said.text}`),
  ).toEqual([]);
  // The lockup is read, so the exception above still has something to excuse.
  expect(all.some(BESIDE_THE_NAME)).toBe(true);
});

test("every word kept for the person to act in is still needed", () => {
  const all = sentences();
  for (const allowed of ALLOWED)
    expect({
      file: allowed.file,
      used: all.some(
        (said) => said.file === allowed.file && allowed.word.test(said.text),
      ),
    }).toEqual({ file: allowed.file, used: true });
});
