import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import {
  ALLOWED,
  type Allowed,
  RULES,
  type Rule,
  STAYS,
  TEMPORARY,
} from "./client-boundary.allow";

/**
 * Guard: every client reaches the server through the API, using the client generated from
 * api/openapi.yaml, and nothing else. A hand-written address of the server, or a request sent by
 * hand, fails here unless api/client-boundary.allow.ts names it with the rule it follows.
 *
 * Read are the clients' own code: the app (app/src, its server app/serve.ts and app/vite.config.ts),
 * mobile, the Recorder (extension/src), shared, the desktop window (desktop/src) and its native side
 * (desktop/src-tauri/src), and the scripts that call a running server. Not read: the generated
 * client, tests, fixtures and comments.
 *
 * Found are:
 * - an address of the server: text in a string, a template or JSX that holds `/api`, `/.well-known`,
 *   `/health` or `/release`, said on its own or after a host on this machine. An address on another
 *   site is not the server's. A template's interpolations are written `{}`.
 * - a request sent by hand: `fetch(`, `new WebSocket(`, `new EventSource(`, `new XMLHttpRequest(`,
 *   `sendBeacon(` and a `<form action>`.
 */
const REPO = join(import.meta.dir, "..");

export type Hit = { file: string; what: string };

const ROOTS: { path: string; extensions: RegExp }[] = [
  { path: "app/src", extensions: /\.tsx?$/ },
  { path: "app/serve.ts", extensions: /\.ts$/ },
  { path: "app/vite.config.ts", extensions: /\.ts$/ },
  { path: "mobile/app", extensions: /\.tsx?$/ },
  { path: "mobile/src", extensions: /\.tsx?$/ },
  { path: "extension/src", extensions: /\.tsx?$/ },
  { path: "shared", extensions: /\.tsx?$/ },
  { path: "desktop/src", extensions: /\.tsx?$/ },
  { path: "desktop/src-tauri/src", extensions: /\.rs$/ },
  { path: "scripts", extensions: /\.(ts|sh)$/ },
];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "generated",
  "dist",
  "target",
  "tests",
  "__tests__",
  "test-fixtures",
  "fixtures",
  "gen",
]);

const IS_TEST = /\.test\.tsx?$|\.spec\.tsx?$|_tests\.rs$/;

function* sourceFiles(path: string, extensions: RegExp): Generator<string> {
  const full = join(REPO, path);
  if (!statSync(full, { throwIfNoEntry: false })) return;
  if (statSync(full).isFile()) {
    if (extensions.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(full)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const child = join(path, name);
    if (statSync(join(REPO, child)).isDirectory())
      yield* sourceFiles(child, extensions);
    else if (extensions.test(name) && !IS_TEST.test(name)) yield child;
  }
}

/** Where the server's address starts in a piece of text. */
const ADDRESS =
  /\/(?:api(?=\/|$|\?|["'`\s])|\.well-known\/|health(?=$|\/|\?|["'`\s])|release(?=$|\?|["'`\s]))/;

/** A host before the address that is this machine, or one the code fills in. */
const OWN_HOST =
  /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal|server|\{\}|\{[a-z_]*\})(?::[^/]*)?$/;

/** The server's address in a piece of text, from its first segment, or null when it holds none. */
export function addressIn(text: string): string | null {
  const match = ADDRESS.exec(text);
  if (!match) return null;
  const before = text.slice(0, match.index);
  // An address on another site, or a file path that only names a directory called `api`.
  if (
    before !== "" &&
    !OWN_HOST.test(before) &&
    !/^\{\}$|^\{\w*\}$/.test(before)
  )
    return null;
  return text.slice(match.index).split(/[\s"'`]/)[0] ?? null;
}

/** A template's text with each interpolation as `{}`. */
function templateText(node: ts.TemplateExpression): string {
  return (
    node.head.text +
    node.templateSpans.map((span) => `{}${span.literal.text}`).join("")
  );
}

function declaresParameter(node: ts.Node, name: string): boolean {
  for (let at: ts.Node | undefined = node; at; at = at.parent)
    if (
      ts.isFunctionLike(at) &&
      at.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    )
      return true;
  return false;
}

const TRANSPORTS = new Set(["WebSocket", "EventSource", "XMLHttpRequest"]);

/** Every address and every request sent by hand in a TypeScript file. */
export function scriptHits(file: string, text: string): Hit[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isImportTypeNode(node)) return;
    let said: string | null = null;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node)
    )
      said = node.text;
    else if (ts.isTemplateExpression(node)) said = templateText(node);
    if (said !== null) {
      const address = addressIn(said);
      if (address !== null) hits.push({ file, what: address });
      // A template's parts are read as one; a JSX text's siblings are read on their own.
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement : node;
      if (
        tag.tagName.getText(source) === "form" &&
        tag.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === "action",
        )
      )
        hits.push({ file, what: "<form action>" });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const global =
        ts.isIdentifier(callee) ||
        (ts.isPropertyAccessExpression(callee) &&
          /^(globalThis|window|self)$/.test(callee.expression.getText(source)));
      if (name === "fetch" && global && !declaresParameter(node, "fetch"))
        hits.push({ file, what: "fetch()" });
      if (name === "sendBeacon") hits.push({ file, what: "sendBeacon()" });
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      TRANSPORTS.has(node.expression.text)
    )
      hits.push({ file, what: `new ${node.expression.text}()` });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/**
 * Every address in a Rust file's own code. Comments and every `#[cfg(test)] mod … { … }` block are
 * passed over, as the native text guard does (tests/no-intelligence-in-user-copy.test.ts).
 */
export function nativeHits(file: string, text: string): Hit[] {
  const token =
    /#\[cfg\(test\)\]\s*mod \w+\s*\{|(?<!\w)b?r(#*)"[\s\S]*?"\1|"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])'|[{}]/g;
  const hits: Hit[] = [];
  let depth = 0;
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
    const body = literal.replace(/^b?r?#*"|"#*$/g, "").replace(/\\\n\s*/g, "");
    const address = addressIn(body);
    if (address !== null) hits.push({ file, what: address });
  }
  return hits;
}

/** Every address in a shell script's commands; comments are passed over. */
export function shellHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const line of text.split("\n")) {
    const code = line.replace(/(^|\s)#.*$/, "");
    for (const word of code.split(/[\s"']+/)) {
      const address = addressIn(word.replace(/\$\{?\w+\}?/g, "{}"));
      if (address !== null) hits.push({ file, what: address });
    }
  }
  return hits;
}

function hitsIn(file: string): Hit[] {
  const text = readFileSync(join(REPO, file), "utf8");
  if (file.endsWith(".rs")) return nativeHits(file, text);
  if (file.endsWith(".sh")) return shellHits(file, text);
  return scriptHits(file, text);
}

function allHits(): Hit[] {
  const files = new Set(
    ROOTS.flatMap((root) => [...sourceFiles(root.path, root.extensions)]),
  );
  return [...files].flatMap(hitsIn);
}

const matches = (entry: Allowed, hit: Hit) =>
  entry.file === hit.file &&
  (typeof entry.what === "string"
    ? entry.what === hit.what
    : entry.what.test(hit.what));

const ENTRIES = [...ALLOWED, ...TEMPORARY];

/** The operations and channels the API describes, each as a pattern of its address. */
function describedAddresses(): RegExp[] {
  const read = (file: string) =>
    parse(readFileSync(join(import.meta.dir, file), "utf8")) as {
      paths?: Record<string, unknown>;
      channels?: Record<string, { address?: string }>;
    };
  const addresses = [
    ...Object.keys(read("openapi.yaml").paths ?? {}),
    ...Object.values(read("asyncapi.yaml").channels ?? {}).flatMap((channel) =>
      channel.address ? [channel.address] : [],
    ),
  ];
  return addresses.map(
    (address) =>
      new RegExp(
        `^${address
          .split(/\{[^}]+\}/)
          .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
          .join("[^/]+")}$`,
      ),
  );
}

let found: Hit[] | undefined;
const hits = () => {
  found ??= allHits();
  return found;
};

test("every address of the server and every request sent by hand is one the allowlist names", () => {
  const unnamed = hits()
    .filter((hit) => !ENTRIES.some((entry) => matches(entry, hit)))
    .map((hit) => `${hit.file}  ${hit.what}`);
  expect(unnamed).toEqual([]);
}, 60_000);

test("every entry of the allowlist still matches something, so none is a hole", () => {
  const stale = ENTRIES.filter(
    (entry) => !hits().some((hit) => matches(entry, hit)),
  ).map((entry) => `${entry.file}  ${String(entry.what)}`);
  expect(stale).toEqual([]);
}, 60_000);

test("every entry follows a named rule, and says why", () => {
  for (const entry of ENTRIES) {
    expect({ entry: entry.file, rule: RULES.includes(entry.rule) }).toEqual({
      entry: entry.file,
      rule: true,
    });
    expect(entry.why.trim().length).toBeGreaterThan(10);
  }
  // Today's hand-written calls are the temporary list's alone, and each names what removes it.
  for (const entry of TEMPORARY) expect(entry.until.trim()).not.toBe("");
  expect(ALLOWED.filter((entry) => entry.rule === "temporary")).toEqual([]);
});

/** Rules whose addresses are not the server's own, or name none. */
const NOT_THE_SERVERS: Rule[] = ["transport", "third-party"];

test("an address allowed for good is one that stays outside the API", () => {
  const outside = hits()
    .filter((hit) =>
      ALLOWED.some(
        (entry) => !NOT_THE_SERVERS.includes(entry.rule) && matches(entry, hit),
      ),
    )
    .map((hit) => hit.what)
    .filter((what) => what.startsWith("/") && !what.startsWith("/api/v2/"))
    .filter((what) => !STAYS.some((prefix) => what.startsWith(prefix.prefix)));
  expect(outside).toEqual([]);
}, 60_000);

test("a whole address in the API's place is one the API describes", () => {
  const described = describedAddresses();
  const undescribed = hits()
    .map((hit) => hit.what.split("?")[0] ?? "")
    // A whole address: the organization's, and something below it, in a path's characters only (a
    // pattern that matches addresses is not one).
    .filter(
      (what) =>
        /^[\w\-./{}~%]+$/.test(what) &&
        /^\/api\/v2\/organizations\/[^/]+\/[^{]/.test(what),
    )
    .filter((what) => !described.some((pattern) => pattern.test(what)));
  expect(undescribed).toEqual([]);
}, 60_000);

test("the scan finds what it is for", () => {
  // A scanner that finds nothing passes every tree.
  const sample = `
    import { x } from "@tauri-apps/api/core";
    // client("/api/commented-out")
    export const a = () => client("/api/memory");
    export const b = (id: string) => client(\`/api/memory/\${id}/sync\`);
    export const c = () => fetch("https://example.com/api/v1/thing");
    export const d = () => fetch(\`http://127.0.0.1:\${port}/health\`);
    export const e = () => new WebSocket("wss://api.x.ai/v1/realtime");
    export const f = () => navigator.sendBeacon("/api/telemetry", "{}");
    export const g = (fetch: () => void) => fetch();
    export const h = () => <p>{origin}/api/events/github/{id}</p>;
  `;
  expect(
    scriptHits("sample.tsx", sample)
      .map((hit) => hit.what)
      .sort(),
  ).toEqual(
    [
      "/api/memory",
      "/api/memory/{}/sync",
      "fetch()",
      "fetch()",
      "/health",
      "new WebSocket()",
      "/api/telemetry",
      "sendBeacon()",
      "/api/events/github/",
    ].sort(),
  );
  expect(
    nativeHits(
      "sample.rs",
      `fn ping() { get(format!("http://127.0.0.1:{port}/api/capabilities")); }
       // "/api/commented"
       #[cfg(test)]
       mod tests { fn t() { assert_eq!(p, "/api/in-a-test"); } }`,
    ).map((hit) => hit.what),
  ).toEqual(["/api/capabilities"]);
  expect(
    shellHits(
      "sample.sh",
      `# curl /api/commented\ncurl -fsS "http://localhost:$port/health"\n`,
    ).map((hit) => hit.what),
  ).toEqual(["/health"]);
});
