import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Guard: a request is addressed to the organization the person is working in, never to a fixed one.
 *
 * The app reads it from `organizationId()` (src/lib/organizations/current.ts) where the request is
 * made. The phone gives a generated call its placeholder, and its one request function fills in the
 * person's organization (mobile/src/api/request.ts). Code that names an organization itself sends
 * everybody's requests to that one, whichever they are working in, and nothing else fails: the
 * request is well formed and an OpenBot with one organization answers it.
 *
 * Read are the app (app/src, which holds the skins) and the phone (mobile/app, mobile/src). Not
 * read: the generated clients, tests and comments.
 *
 * Found are:
 * - the constant `ORGANIZATION_ID`, which the app no longer has: any mention in the app, and on the
 *   phone any declaration of it, since the phone's own is the placeholder and is listed below;
 * - an address written with `/organizations/default` in it;
 * - `"default"` given as an organization: to a name that says organization (`organizationId:
 *   "default"`, `const ORGANIZATION = "default"`), or as the first argument of a call, which is
 *   where every generated function takes its organization.
 *
 * {@link EXPECTED} lists the few that are right, each with its reason. One that is no longer found
 * fails too, so the list stays what the code does.
 */
const REPO = join(import.meta.dir, "..", "..");

type Hit = { file: string; line: number; what: string };

const ROOTS = ["app/src", "mobile/app", "mobile/src"];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "generated",
  "dist",
  "tests",
  "__tests__",
]);
const IS_SOURCE = /\.tsx?$/;
const IS_TEST = /\.(test|spec|probe)\.tsx?$/;

function* sourceFiles(path: string): Generator<string> {
  const full = join(REPO, path);
  if (!statSync(full, { throwIfNoEntry: false })) return;
  for (const name of readdirSync(full)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const child = join(path, name);
    if (statSync(join(REPO, child)).isDirectory()) yield* sourceFiles(child);
    else if (IS_SOURCE.test(name) && !IS_TEST.test(name)) yield child;
  }
}

const REMOVED = "ORGANIZATION_ID";
const FIXED = "default";
const FIXED_ADDRESS = /\/organizations\/default(?=$|[/?#"'`\s])/;
const NAMES_ORGANIZATION = /organi[sz]ation/i;

/** The text a string or a template holds, with each interpolation as `{}`. */
function said(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isJsxText(node)
  )
    return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((span) => `{}${span.literal.text}`).join("")
    );
  return null;
}

/** The name a value is given to: a constant, a property, a parameter's default or a JSX attribute. */
function givenTo(node: ts.Node): string | null {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  )
    return parent.name.getText();
  if (ts.isJsxAttribute(parent)) return parent.name.getText();
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent))
    return parent.parent.name.getText();
  return null;
}

/** Every place a file names an organization itself. */
export function organizationHits(file: string, text: string): Hit[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const phone = file.startsWith("mobile/");
  const hits: Hit[] = [];
  const hit = (node: ts.Node, what: string) =>
    hits.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      what,
    });
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === REMOVED) {
      const declared =
        ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!phone) hit(node, REMOVED);
      else if (declared)
        hit(node, `${REMOVED} = ${node.parent.initializer?.getText() ?? ""}`);
    }
    const words = said(node);
    if (words !== null && FIXED_ADDRESS.test(words)) hit(node, words.trim());
    if (ts.isStringLiteralLike(node) && node.text === FIXED) {
      const name = givenTo(node);
      // A declaration of the removed constant is already reported above, whatever it holds.
      if (name === REMOVED) return;
      if (name !== null && NAMES_ORGANIZATION.test(name))
        hit(node, `${name} = "${FIXED}"`);
      else if (
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node
      )
        hit(node, `${node.parent.expression.getText()}("${FIXED}")`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** The ones that are right. `what` is what the scan reports for it. */
const EXPECTED: { file: string; what: string; why: string }[] = [
  {
    file: "app/src/lib/api/request.ts",
    what: 'DEPLOYMENT_ORGANIZATION = "default"',
    why: "what the deployment offers is asked before sign-in, of the organization every install has",
  },
  {
    file: "app/src/lib/organizations/queries.ts",
    what: 'ONLY_ORGANIZATION = "default"',
    why: "an OpenBot that keeps one organization lists none, and the API addresses its one as default",
  },
  {
    file: "mobile/src/api/request.ts",
    what: 'DEPLOYMENT_ORGANIZATION_ID = "default"',
    why: "the phone's same two cases: the question before sign-in, and an OpenBot with no list",
  },
  {
    file: "mobile/src/api/request.ts",
    what: 'ORGANIZATION_ID = "{organizationId}"',
    why: "the phone's placeholder, which its request function replaces with the person's organization",
  },
];

const key = (each: { file: string; what: string }) =>
  `${each.file}: ${each.what}`;

function everyHit(): Hit[] {
  return ROOTS.flatMap((root) =>
    [...sourceFiles(root)].flatMap((file) =>
      organizationHits(file, readFileSync(join(REPO, file), "utf8")),
    ),
  );
}

test("no request names an organization itself: each is addressed to the one the person is working in", () => {
  const expected = new Set(EXPECTED.map(key));
  const unexpected = everyHit()
    .filter((each) => !expected.has(key(each)))
    .map((each) => `${each.file}:${each.line}: ${each.what}`);
  // Each line is a file, its line and what was written there. In the app, ask organizationId()
  // where the request is made. On the phone, pass the request helper's ORGANIZATION_ID.
  expect(unexpected).toEqual([]);
});

test("every listed exception is still in the code", () => {
  const found = new Set(everyHit().map(key));
  expect(EXPECTED.map(key).filter((each) => !found.has(each))).toEqual([]);
});

/** How an interpolation opens in the sample code below, written so this file holds none of its own there. */
const OPEN = ["$", "{"].join("");

test("the scan finds each way of naming an organization, and leaves the current one alone", () => {
  const app = organizationHits(
    "app/src/example.tsx",
    [
      'import { ORGANIZATION_ID } from "@/lib/api/request";',
      "listBots(ORGANIZATION_ID);",
      'listBots("default");',
      'fetch("/api/v2/organizations/default/bots");',
      `open(\`/api/v2/organizations/default/computers/${OPEN}id}/screen\`);`,
      'recordEvent({ organizationId: "default" });',
      "// /api/v2/organizations/default/bots is only a comment",
      "listBots(organizationId());",
      '<Button variant="default" />;',
      'const size = "default";',
      `open(\`/api/v2/organizations/${OPEN}organizationId()}/defaults\`);`,
    ].join("\n"),
  );
  expect(app.map((each) => `${each.line}: ${each.what}`)).toEqual([
    "1: ORGANIZATION_ID",
    "2: ORGANIZATION_ID",
    '3: listBots("default")',
    "4: /api/v2/organizations/default/bots",
    "5: /api/v2/organizations/default/computers/{}/screen",
    '6: organizationId = "default"',
  ]);
  const phone = organizationHits(
    "mobile/src/example.ts",
    [
      'import { ORGANIZATION_ID } from "./api";',
      "listBots(ORGANIZATION_ID);",
      'const ORGANIZATION_ID = "default";',
    ].join("\n"),
  );
  expect(phone.map((each) => `${each.line}: ${each.what}`)).toEqual([
    '3: ORGANIZATION_ID = "default"',
  ]);
});
