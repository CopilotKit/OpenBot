import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Every object a request body holds says whether it takes keys it doesn't name.
 *
 * The server's schemas are generated from this spec with strict bodies, and the generator reads an
 * object that names properties and says nothing about additionalProperties as closed. So silence
 * would close an object nobody decided to close, and an object meant to be open (an app's own
 * arguments, an AG-UI message) has to say `additionalProperties: true`. Saying it, either way, is
 * what this holds every request body to, at every depth.
 *
 * It also holds that no allOf joins two parts that both name properties when either is closed: in
 * JSON Schema each closed part would refuse the other part's keys, so no request could satisfy it.
 * A body like that is written as one closed object (CreateBotRequest is).
 */

type Schema = Record<string, unknown>;
type Spec = {
  paths: Record<string, Record<string, Schema>>;
  components: Record<string, Record<string, Schema>>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;
const METHODS = ["get", "post", "put", "patch", "delete"];

function deref(node: unknown): Schema | undefined {
  let current = node as Schema | undefined;
  for (let hops = 0; current && typeof current.$ref === "string"; hops++) {
    if (hops > 20) throw new Error(`A $ref loop at ${String(current.$ref)}`);
    const path = (current.$ref as string).replace(/^#\//, "").split("/");
    current = path.reduce<unknown>(
      (at, part) => (at as Record<string, unknown> | undefined)?.[part],
      spec,
    ) as Schema | undefined;
  }
  return current;
}

const names = (node: Schema) =>
  Object.keys((node.properties as Record<string, unknown>) ?? {}).length > 0;
const states = (node: Schema) =>
  "additionalProperties" in node || "unevaluatedProperties" in node;
const closed = (node: Schema) =>
  node.additionalProperties === false || node.unevaluatedProperties === false;

/** Every place in one body where an object is silent, or an allOf can't be satisfied. */
function problemsIn(body: unknown): string[] {
  const problems: string[] = [];
  const seen = new Set<Schema>();
  const walk = (raw: unknown, where: string) => {
    const node = deref(raw);
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    // Read only: it comes back in answers and is never sent, so no request body holds it.
    if (node.readOnly === true) return;
    if (names(node) && !states(node))
      problems.push(`${where}: names properties but not additionalProperties`);
    const parts = (node.allOf as unknown[] | undefined)
      ?.map(deref)
      .filter((part): part is Schema => !!part && names(part));
    if (parts && parts.length > 1 && parts.some(closed))
      problems.push(
        `${where}: an allOf of parts that each name properties, one closed`,
      );
    for (const key of ["allOf", "oneOf", "anyOf"] as const) {
      const branches = (node[key] as unknown[] | undefined) ?? [];
      for (const [index, branch] of branches.entries())
        walk(branch, `${where}.${key}[${index}]`);
    }
    if (node.items) walk(node.items, `${where}[]`);
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === "object"
    )
      walk(node.additionalProperties, `${where}{*}`);
    for (const [name, child] of Object.entries(
      (node.properties as Record<string, unknown>) ?? {},
    ))
      walk(child, `${where}.${name}`);
  };
  walk(body, "body");
  return problems;
}

const bodies = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.flatMap((method) => {
    const operation = item[method];
    const body = deref(operation?.requestBody);
    const content = body?.content as
      | Record<string, { schema?: unknown }>
      | undefined;
    const schema = content?.["application/json"]?.schema;
    return schema
      ? [
          {
            name: `${String(operation?.operationId)} (${method.toUpperCase()} ${path})`,
            schema,
          },
        ]
      : [];
  }),
);

test("the spec has request bodies to check", () => {
  expect(bodies.length).toBeGreaterThan(100);
});

test("every object in a request body says whether it takes keys it doesn't name", () => {
  const found = bodies.flatMap(({ name, schema }) =>
    problemsIn(schema).map((problem) => `${name} ${problem}`),
  );
  expect(found).toEqual([]);
});
