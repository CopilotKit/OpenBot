import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * An open enum (`x-extensible-enum`) is only ever in an answer.
 *
 * Declaring an enum open lets the server add a value without breaking a client, because every client
 * reads a value it doesn't know as "other" (api/README.md, Enums that grow). That holds only for what
 * the server sends. Where a request carries the enum, the server's generated schema for that request
 * would take any string, so a request could save a value nothing knows. So no parameter and no
 * request body may reach one, at any depth, and an open enum never has an `enum` beside it.
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

/** Every open enum `raw` reaches, by where it is. */
function openEnumsIn(
  raw: unknown,
  where: string,
  seen = new Set<Schema>(),
): string[] {
  const node = deref(raw);
  if (!node || typeof node !== "object" || seen.has(node)) return [];
  seen.add(node);
  const found = "x-extensible-enum" in node ? [where] : [];
  for (const key of ["allOf", "oneOf", "anyOf"])
    for (const [index, branch] of ((node[key] as unknown[]) ?? []).entries())
      found.push(...openEnumsIn(branch, `${where}/${key}/${index}`, seen));
  for (const [name, property] of Object.entries(
    (node.properties as Record<string, unknown>) ?? {},
  ))
    found.push(...openEnumsIn(property, `${where}/${name}`, seen));
  if (node.items) found.push(...openEnumsIn(node.items, `${where}[]`, seen));
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === "object"
  )
    found.push(...openEnumsIn(node.additionalProperties, `${where}{}`, seen));
  return found;
}

test("no request reaches an open enum", () => {
  const reached: string[] = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const name = `${method.toUpperCase()} ${path}`;
      const parameters = [
        ...((item.parameters as unknown[]) ?? []),
        ...((operation.parameters as unknown[]) ?? []),
      ];
      for (const raw of parameters) {
        const parameter = deref(raw);
        reached.push(
          ...openEnumsIn(
            parameter?.schema,
            `${name} ${String(parameter?.in)} ${String(parameter?.name)}`,
          ),
        );
      }
      const body = deref(operation.requestBody);
      for (const [type, media] of Object.entries(
        (body?.content as Record<string, Schema>) ?? {},
      ))
        reached.push(...openEnumsIn(media.schema, `${name} body ${type}`));
    }
  expect(reached).toEqual([]);
});

test("an open enum has no enum beside it, and lists its values", () => {
  const wrong: string[] = [];
  const visit = (node: unknown, where: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries())
        visit(item, `${where}/${index}`);
      return;
    }
    const schema = node as Schema;
    if ("x-extensible-enum" in schema) {
      const values = schema["x-extensible-enum"];
      if ("enum" in schema)
        wrong.push(`${where} has both enum and x-extensible-enum`);
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.includes(null)
      )
        wrong.push(
          `${where} lists no values, or lists null: say null in its type instead`,
        );
    }
    for (const [key, value] of Object.entries(schema))
      visit(value, `${where}/${key}`);
  };
  visit(spec, "#");
  expect(wrong).toEqual([]);
});
