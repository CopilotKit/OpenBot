import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The vault's secrets go one way. Every answer the credential operations can give is a schema with no
 * place to put a secret, and the one field that carries a secret is declared write-only, so a client
 * generated from the spec, and the server's answers checked against it, can never hand one back.
 */

type Schema = {
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  writeOnly?: boolean;
};
type Operation = {
  operationId: string;
  tags?: string[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<
    string,
    { $ref?: string; content?: Record<string, { schema: Schema }> }
  >;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
  };
};

const operations = Object.values(spec.paths).flatMap((item) =>
  Object.values(item).filter(
    (value): value is Operation =>
      typeof value === "object" && value !== null && "operationId" in value,
  ),
);

/** Every property name a schema can hold, through references, arrays and compositions. */
function propertyNames(
  schema: Schema | undefined,
  seen = new Set<string>(),
): string[] {
  if (!schema) return [];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return [];
    seen.add(name);
    return propertyNames(spec.components.schemas[name], seen);
  }
  return [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => [
      name,
      ...propertyNames(property, seen),
    ]),
    ...propertyNames(schema.items, seen),
    ...(typeof schema.additionalProperties === "object"
      ? propertyNames(schema.additionalProperties, seen)
      : []),
    ...[
      ...(schema.allOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
    ].flatMap((part) => propertyNames(part, seen)),
  ];
}

const SECRET_NAMES = [
  "secret",
  "plaintext",
  "encryptedValue",
  "value",
  "token",
  "apiKey",
];

test("no answer about the vault has a place for a secret", () => {
  const vault = operations.filter((operation) =>
    operation.tags?.includes("Credentials"),
  );
  expect(vault.map((operation) => operation.operationId).sort()).toEqual([
    "createCredential",
    "getModelKey",
    "listCredentials",
    "revokeCredential",
  ]);
  for (const operation of vault) {
    for (const [status, response] of Object.entries(operation.responses)) {
      if (!/^2/.test(status)) continue;
      const body = response.content?.["application/json"]?.schema;
      expect(body).toBeDefined();
      const names = propertyNames(body);
      for (const secret of SECRET_NAMES) expect(names).not.toContain(secret);
    }
  }
});

test("the secret a credential is added with is write-only", () => {
  const input = spec.components.schemas.CredentialInput;
  expect(input?.properties?.secret?.writeOnly).toBe(true);
  // Nothing else in the input is write-only: the rest is what the vault shows back.
  expect(
    Object.entries(input?.properties ?? {})
      .filter(([, property]) => property.writeOnly)
      .map(([name]) => name),
  ).toEqual(["secret"]);
});
