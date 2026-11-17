import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  GetAiConnectionResponse,
  ReplaceAiConnectionBody,
} from "../app/src/lib/api/generated/models/models.zod";

/**
 * The AI connection: one per organization, read and switched by an administrator with no restart.
 * A key goes in once and never comes back out, a bad connection is refused before anything is saved
 * with one of five stated reasons, and every example the spec shows is one the generated client
 * accepts, so a fake built from the examples matches what the server answers.
 */

type Schema = {
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  writeOnly?: boolean;
};
type Example = { value?: unknown; $ref?: string };
type Media = { schema: Schema; examples?: Record<string, Example> };
type Response = { $ref?: string; content?: Record<string, Media> };
type Operation = {
  operationId: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { $ref: string }[];
  requestBody?: { content: Record<string, Media> };
  responses: Record<string, Response>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, Response>;
    examples: Record<string, Example>;
  };
};

const PATH = "/api/v2/organizations/{organizationId}/ai-connection";
const item = spec.paths[PATH] ?? {};
const read = item.get;
const replace = item.put;

function response(ref: Response): Response {
  if (!ref.$ref) return ref;
  return spec.components.responses[
    ref.$ref.replace("#/components/responses/", "")
  ] as Response;
}
function exampleValue(example: Example): unknown {
  if (!example.$ref) return example.value;
  return spec.components.examples[
    example.$ref.replace("#/components/examples/", "")
  ]?.value;
}
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
    ...(schema.oneOf ?? []).flatMap((part) => propertyNames(part, seen)),
  ];
}

test("an administrator reads and replaces the one AI connection, a replace taking an Idempotency-Key", () => {
  expect(read?.operationId).toBe("getAiConnection");
  expect(replace?.operationId).toBe("replaceAiConnection");
  expect(read?.tags).toEqual(["Models"]);
  expect(replace?.tags).toEqual(["Models"]);
  expect(read?.security).toContainEqual({ appOAuth: ["ai-connection:read"] });
  expect(replace?.security).toContainEqual({
    appOAuth: ["ai-connection:write"],
  });
  expect(read?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(replace?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(replace?.parameters?.map((p) => p.$ref)).toContainEqual(
    expect.stringContaining("IdempotencyKey"),
  );
});

test("no answer has a place for a key, and the key sent is write-only", () => {
  for (const operation of [read, replace]) {
    const body =
      operation?.responses["200"]?.content?.["application/json"]?.schema;
    expect(body).toBeDefined();
    const names = propertyNames(body);
    for (const secret of ["apiKey", "secret", "token", "key"]) {
      expect(names).not.toContain(secret);
    }
  }
  const input = spec.components.schemas.AiConnectionInput;
  expect(
    Object.entries(input?.properties ?? {})
      .filter(([, property]) => property.writeOnly)
      .map(([name]) => name),
  ).toEqual(["apiKey"]);
});

test("a connection OpenBot can't use is refused with one of five reasons, in OpenBot's own words", () => {
  const refused = response(replace?.responses["422"] ?? {});
  const examples = Object.values(
    refused.content?.["application/problem+json"]?.examples ?? {},
  ).map((example) => exampleValue(example) as { code: string; detail: string });
  expect(examples.map((example) => example.code).sort()).toEqual([
    "AI_CONNECTION_ENGINE_NOT_READY",
    "AI_CONNECTION_KEY_REFUSED",
    "AI_CONNECTION_MODEL_UNAVAILABLE",
    "AI_CONNECTION_SIGN_IN_MISSING",
    "AI_CONNECTION_UNREACHABLE",
  ]);
  for (const example of examples) {
    expect(example.detail).not.toContain("—");
    expect(example.detail).toMatch(/\.$/);
  }
  const fixed = response(replace?.responses["409"] ?? {});
  const codes = Object.values(
    fixed.content?.["application/problem+json"]?.examples ?? {},
  ).map((example) => (exampleValue(example) as { code: string }).code);
  expect(codes.sort()).toEqual([
    "AI_CONNECTION_FIXED",
    "IDEMPOTENCY_KEY_CONFLICT",
  ]);
});

test("every example the spec shows is one the generated client accepts", () => {
  const answers = [read, replace].flatMap((operation) =>
    Object.values(
      operation?.responses["200"]?.content?.["application/json"]?.examples ??
        {},
    ),
  );
  expect(answers.length).toBeGreaterThanOrEqual(4);
  for (const example of answers) {
    expect(
      GetAiConnectionResponse.safeParse(exampleValue(example)).success,
    ).toBe(true);
  }
  const bodies = Object.values(
    replace?.requestBody?.content["application/json"]?.examples ?? {},
  );
  expect(bodies.length).toBeGreaterThanOrEqual(4);
  for (const example of bodies) {
    expect(
      ReplaceAiConnectionBody.safeParse(exampleValue(example)).success,
    ).toBe(true);
  }
});

test("an endpoint address is http or https with nothing in it that signs in", () => {
  const endpoint = (baseUrl: string) =>
    ReplaceAiConnectionBody.safeParse({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl,
      model: "llama-5",
    }).success;
  expect(endpoint("https://api.example.com/v1")).toBe(true);
  expect(endpoint("http://127.0.0.1:11434/v1")).toBe(true);
  expect(endpoint("https://user:secret@api.example.com/v1")).toBe(false);
  expect(endpoint("https://key@api.example.com")).toBe(false);
  expect(endpoint("ftp://api.example.com")).toBe(false);
  expect(endpoint("file:///etc/passwd")).toBe(false);
  // Unknown fields are refused, so a key can't ride in under another name.
  expect(
    (
      spec.components.schemas.AiConnectionInput as {
        additionalProperties?: boolean;
      }
    ).additionalProperties,
  ).toBe(false);
});
