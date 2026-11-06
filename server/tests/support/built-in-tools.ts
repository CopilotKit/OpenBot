// server/tests/support/built-in-tools.ts
/**
 * Every tool OpenBot itself offers a model, read out of the source where each one is registered.
 *
 * WHY THE SOURCE AND NOT A LIST. The guard this feeds exists because tools shipped with no words for
 * the transcript (`copilotkit_load_skill`, `list_bots`, `remember_personal_fact`) and the person saw
 * the identifier. A hand-kept list of tool names would have been missing exactly those, for the same
 * reason the label table was. So the names are read from the registrations themselves, and a tool
 * added tomorrow is in the scan the day it lands.
 *
 * WHAT COUNTS AS A REGISTRATION. A tool is offered to a model as a name and a description, whoever
 * runs it: a server `GrantedTool`, an AG-UI `Tool` the runtime hands the model, a headless computer
 * tool's definition, the config of a browser `useFrontendTool` or `useHumanInTheLoop`. Each is an
 * object literal with `name`, `description` and one of `parameters`, `execute` or `handler`, which is
 * the shape this looks for. Three shapes are deliberately not it:
 *
 *   - `useRenderTool` draws a tool somebody else runs and has no description, so it registers
 *     nothing: the server's own registration of that tool is what is found.
 *   - An app's tool, built-in Routines included, is described with `inputSchema` the way an MCP
 *     server answers `tools/list`, and reaches the model as `mcp__<app>__<tool>`, which
 *     `readToolName` already turns into words.
 *   - A zod schema written in the same shape (`z.object({ name: z.string(), ... })`) describes a
 *     tool somebody else sends, and is not one.
 *
 * A registration that carries its own `Component` is a gallery component: drawn as itself, never as
 * a line, and named for the model by whoever wrote it. Those are returned apart, in `components`.
 *
 * HOW A NAME IS READ. A string literal is the name. A template literal is every name its parts can
 * make. An identifier is followed to the `const` it names (in this file, or exported from another),
 * to the array a `for...of` takes it from, or, for a helper's parameter (`function tool(name, ...)`),
 * to every call of that helper in the same file. Anything else, `spec.name` or `tool.toolName`, or a
 * callback's parameter, is a name decided at run time and is returned as dynamic, so the guard can
 * insist each of those is one of the few that are meant to be.
 *
 * Parsed with the TypeScript parser, not matched with a pattern: a registration is an expression
 * prettier wraps however it likes, and a parser does not care.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { sourceFiles } from "./source-scan";

/** One registration's name, and where the name was written. */
export type NamedTool = { name: string; file: string; line: number };

/** A registration whose name could not be read as a literal, as `file: expression`. */
export type UnnamedTool = { site: string; file: string; line: number };

export type BuiltInTools = {
  named: NamedTool[];
  /** Gallery components, which draw themselves. */
  components: NamedTool[];
  /** Names decided at run time: a tool passed through, an app's tool, a component. */
  dynamic: UnnamedTool[];
  /** A name that looked followable and was not. A guard fails on these rather than skipping them. */
  unresolved: UnnamedTool[];
};

/** Where OpenBot's own TypeScript lives: every package that can register a tool with a model. */
export const BUILT_IN_TOOL_ROOTS = [
  "server/src",
  "app/src",
  "toolkit/src",
  "shared",
  "worker/src",
  "agent-bot/src",
  "agent-computer/src",
] as const;

function isTestFile(path: string): boolean {
  return (
    /\.test\.tsx?$/.test(path) ||
    path.includes("/tests/") ||
    path.includes("node_modules/")
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return unwrap(node.expression);
  return node;
}

function literalValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const bare = unwrap(node);
  if (ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare))
    return bare.text;
  return undefined;
}

/** `const NAME = "value"` anywhere in a file, every value each name is given. */
function stringConstants(source: ts.SourceFile): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    ) {
      const value = literalValue(node.initializer);
      if (value !== undefined)
        found.set(
          node.name.text,
          (found.get(node.name.text) ?? new Set()).add(value),
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function propertyNamed(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return literal.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
}

/** `z.object({...})` and its kin: a schema for something shaped like a tool, not a tool. */
function isSchemaShape(literal: ts.ObjectLiteralExpression): boolean {
  const call = literal.parent;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "z"
  );
}

/** A name and a description, and something a model can call it with. */
function isToolDefinition(literal: ts.ObjectLiteralExpression): boolean {
  return (
    propertyNamed(literal, "name") !== undefined &&
    propertyNamed(literal, "description") !== undefined &&
    ["parameters", "execute", "handler"].some(
      (key) => propertyNamed(literal, key) !== undefined,
    ) &&
    propertyNamed(literal, "inputSchema") === undefined &&
    !isSchemaShape(literal)
  );
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Where an identifier is bound, looking outward from it: a parameter, or a `for...of` variable. */
type Binding =
  | { kind: "parameter"; fn: FunctionLike; index: number }
  | { kind: "loop"; over: ts.Expression; position: number | null };

function bindingOf(identifier: ts.Identifier): Binding | undefined {
  for (let node: ts.Node = identifier; node.parent; node = node.parent) {
    if (isFunctionLike(node)) {
      const index = node.parameters.findIndex(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === identifier.text,
      );
      if (index >= 0) return { kind: "parameter", fn: node, index };
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      for (const declaration of node.initializer.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === identifier.text
        )
          return { kind: "loop", over: node.expression, position: null };
        if (ts.isArrayBindingPattern(declaration.name)) {
          const position = declaration.name.elements.findIndex(
            (element) =>
              ts.isBindingElement(element) &&
              ts.isIdentifier(element.name) &&
              element.name.text === identifier.text,
          );
          if (position >= 0)
            return { kind: "loop", over: node.expression, position };
        }
      }
    }
  }
  return undefined;
}

/** What a helper is called by: its declared name, or the variable it was assigned to. */
function helperName(fn: FunctionLike): string | undefined {
  if (
    (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
    fn.name &&
    ts.isIdentifier(fn.name)
  )
    return fn.name.text;
  if (
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name) &&
    fn.parent.initializer === fn
  )
    return fn.parent.name.text;
  return undefined;
}

function callsOf(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** What one expression can name: literal names (each with where it was written), or why not. */
type Reading =
  | { names: { name: string; at: ts.Node }[] }
  | { dynamic: ts.Expression }
  | { unresolved: ts.Node };

/**
 * Every tool registered under `repoRoot`, by the rules at the top of this file.
 *
 * Constants are read from every scanned file first, so `name: SHOW_APP_ACCESS_TOOL` finds the value
 * `shared/connect-prompt.ts` gives it. A constant given two values, in one file or across two, is
 * reported unresolved, never guessed at.
 */
export function builtInTools(repoRoot: string): BuiltInTools {
  const files = BUILT_IN_TOOL_ROOTS.flatMap((root) =>
    sourceFiles(join(repoRoot, root), [".ts", ".tsx"]),
  ).filter((file) => !isTestFile(relative(repoRoot, file)));
  const sources = files.map((file) =>
    ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  );

  const local = new Map<ts.SourceFile, Map<string, Set<string>>>();
  const everywhere = new Map<string, Set<string>>();
  for (const source of sources) {
    const constants = stringConstants(source);
    local.set(source, constants);
    for (const [name, values] of constants)
      everywhere.set(
        name,
        new Set([...(everywhere.get(name) ?? []), ...values]),
      );
  }

  const result: BuiltInTools = {
    named: [],
    components: [],
    dynamic: [],
    unresolved: [],
  };
  for (const source of sources) {
    const file = relative(repoRoot, source.fileName);
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const constant = (name: string): string | undefined => {
      const values = local.get(source)?.get(name) ?? everywhere.get(name);
      return values?.size === 1 ? [...values][0] : undefined;
    };

    const all = (readings: Reading[], whole: ts.Node): Reading => {
      const names: { name: string; at: ts.Node }[] = [];
      for (const reading of readings) {
        if (!("names" in reading)) return reading;
        names.push(...reading.names);
      }
      return names.length > 0 ? { names } : { unresolved: whole };
    };

    const read = (expression: ts.Expression, at: ts.Node): Reading => {
      const bare = unwrap(expression);
      const literal = literalValue(bare);
      if (literal !== undefined) return { names: [{ name: literal, at }] };

      if (ts.isTemplateExpression(bare)) {
        let made: string[] = [bare.head.text];
        for (const span of bare.templateSpans) {
          const part = read(span.expression, at);
          if (!("names" in part)) return part;
          made = made.flatMap((prefix) =>
            part.names.map(
              ({ name }) => `${prefix}${name}${span.literal.text}`,
            ),
          );
        }
        return { names: made.map((name) => ({ name, at })) };
      }

      if (ts.isArrayLiteralExpression(bare))
        return all(
          bare.elements.map((element) => read(element, at)),
          bare,
        );

      if (!ts.isIdentifier(bare)) return { dynamic: bare };

      const binding = bindingOf(bare);
      if (binding?.kind === "loop") {
        const over = unwrap(binding.over);
        if (!ts.isArrayLiteralExpression(over)) return { dynamic: bare };
        return all(
          over.elements.map((element) => {
            if (binding.position === null) return read(element, at);
            const tuple = unwrap(element);
            const item = ts.isArrayLiteralExpression(tuple)
              ? tuple.elements[binding.position]
              : undefined;
            return item ? read(item, at) : { unresolved: element };
          }),
          over,
        );
      }
      if (binding?.kind === "parameter") {
        const helper = helperName(binding.fn);
        // A callback's parameter (`names.map((name) => ...)`) is whatever it is handed at run time.
        if (!helper) return { dynamic: bare };
        const calls = callsOf(source, helper);
        return all(
          calls.map((call) => {
            const argument = call.arguments[binding.index];
            return argument ? read(argument, call) : { unresolved: call };
          }),
          bare,
        );
      }
      const value = constant(bare.text);
      return value !== undefined
        ? { names: [{ name: value, at }] }
        : { unresolved: bare };
    };

    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node) && isToolDefinition(node)) {
        const property = propertyNamed(node, "name");
        const expression =
          property && ts.isPropertyAssignment(property)
            ? property.initializer
            : property && ts.isShorthandPropertyAssignment(property)
              ? property.name
              : undefined;
        if (expression) {
          const reading = read(expression, property ?? node);
          const drawsItself = propertyNamed(node, "Component") !== undefined;
          if ("names" in reading)
            for (const { name, at } of reading.names)
              (drawsItself ? result.components : result.named).push({
                name,
                file,
                line: lineOf(at),
              });
          else if ("dynamic" in reading)
            result.dynamic.push({
              site: `${file}: ${reading.dynamic.getText(source)}`,
              file,
              line: lineOf(reading.dynamic),
            });
          else
            result.unresolved.push({
              site: `${file}: ${reading.unresolved.getText(source)}`,
              file,
              line: lineOf(reading.unresolved),
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
}
