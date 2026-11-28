import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  AcceptServiceTermsBody,
  GetServiceTermsResponse,
} from "../app/src/lib/api/generated/people/people.zod";

/**
 * The terms a person agrees to before they use OpenBot Cloud: read and agreed to by the person
 * alone, by the version they were shown, with a self-hosted OpenBot answering that there are none.
 * Every example the spec shows is one the generated client accepts, so a fake built from the
 * examples matches what the server answers.
 */

type Example = { value?: unknown; $ref?: string };
type Media = { schema: unknown; examples?: Record<string, Example> };
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
    responses: Record<string, Response>;
    examples: Record<string, Example>;
  };
};

const TERMS = "/api/v2/organizations/{organizationId}/people/{personId}/terms";
const read = spec.paths[TERMS]?.get;
const accept = spec.paths[`${TERMS}/accept`]?.post;

function exampleValue(example: Example): unknown {
  if (!example.$ref) return example.value;
  return spec.components.examples[
    example.$ref.replace("#/components/examples/", "")
  ]?.value;
}

test("only the person reads and agrees to their terms, agreeing taking an Idempotency-Key", () => {
  expect(read?.operationId).toBe("getServiceTerms");
  expect(accept?.operationId).toBe("acceptServiceTerms");
  for (const operation of [read, accept]) {
    expect(operation?.tags).toEqual(["People"]);
    expect(operation?.responses["403"]?.$ref).toContain("OwnOnly");
  }
  expect(read?.security).toContainEqual({ appOAuth: ["people:read"] });
  expect(accept?.security).toContainEqual({ appOAuth: ["people:write"] });
  expect(accept?.parameters?.map((p) => p.$ref)).toContainEqual(
    expect.stringContaining("IdempotencyKey"),
  );
});

test("every answer the spec shows parses, from no terms to terms that changed", () => {
  const answers = [read, accept].flatMap((operation) =>
    Object.values(
      operation?.responses["200"]?.content?.["application/json"]?.examples ??
        {},
    ).map(exampleValue),
  );
  expect(answers.length).toBeGreaterThanOrEqual(5);
  for (const answer of answers) {
    expect(GetServiceTermsResponse.safeParse(answer).success).toBe(true);
  }
  const needed = answers.map(
    (answer) => (answer as { acceptanceNeeded: boolean }).acceptanceNeeded,
  );
  expect(needed).toContain(true);
  expect(needed).toContain(false);
  for (const body of Object.values(
    accept?.requestBody?.content["application/json"]?.examples ?? {},
  )) {
    expect(AcceptServiceTermsBody.safeParse(exampleValue(body)).success).toBe(
      true,
    );
  }
  // An agreement needs the version the person was shown.
  expect(AcceptServiceTermsBody.safeParse({}).success).toBe(false);
});

test("agreeing to a version that isn't current, or where there are no terms, is refused in OpenBot's words", () => {
  const ref = accept?.responses["409"]?.$ref ?? "";
  const conflict =
    spec.components.responses[ref.replace("#/components/responses/", "")];
  const examples = Object.values(
    conflict?.content?.["application/problem+json"]?.examples ?? {},
  ).map((example) => exampleValue(example) as { code: string; detail: string });
  expect(examples.map((example) => example.code).sort()).toEqual([
    "IDEMPOTENCY_KEY_CONFLICT",
    "SERVICE_TERMS_CHANGED",
    "SERVICE_TERMS_NONE",
  ]);
  for (const example of examples) {
    expect(example.detail).not.toContain("—");
    expect(example.detail).toMatch(/\.$/);
  }
});
