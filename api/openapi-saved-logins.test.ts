import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import * as savedLogins from "../app/src/lib/api/generated/saved-logins/saved-logins.zod";

/**
 * Deleting, in one go, the saved logins nobody in an organization may use any more: those of members
 * the Password manager switch is off for, and those of people removed from the organization. Only an
 * administrator does it, it takes no body, and it answers with a count for each group. Every example
 * the spec shows is one the generated client accepts.
 *
 * Before it, an administrator can read the same two counts without deleting anything
 * (`getUnusableSavedLogins`), so a confirmation can say how many it will delete.
 */

type Example = { value?: unknown; $ref?: string };
type Media = { schema: unknown; examples?: Record<string, Example> };
type Response = { $ref?: string; content?: Record<string, Media> };
type Operation = {
  operationId: string;
  tags?: string[];
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: { $ref: string }[];
  requestBody?: unknown;
  responses: Record<string, Response>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: { examples: Record<string, Example> };
};

const PURGE = "/api/v2/organizations/{organizationId}/saved-logins/purge";
const purge = spec.paths[PURGE]?.post;
const UNUSABLE = "/api/v2/organizations/{organizationId}/saved-logins/unusable";
const unusable = spec.paths[UNUSABLE]?.get;

function exampleValue(example: Example): unknown {
  if (!example.$ref) return example.value;
  return spec.components.examples[
    example.$ref.replace("#/components/examples/", "")
  ]?.value;
}

test("only an administrator purges saved logins, with no body and an Idempotency-Key", () => {
  expect(purge?.operationId).toBe("purgeSavedLogins");
  expect(purge?.tags).toEqual(["Saved logins"]);
  expect(purge?.requestBody).toBeUndefined();
  expect(purge?.security).toContainEqual({
    appOAuth: ["saved-logins:write"],
  });
  expect(purge?.parameters?.map((parameter) => parameter.$ref)).toContainEqual(
    expect.stringContaining("IdempotencyKey"),
  );
  expect(purge?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(purge?.description).toContain("personal edition");
});

test("the answer counts each group, and every example the spec shows parses", () => {
  const Answer = (savedLogins as Record<string, unknown>)
    .PurgeSavedLoginsResponse as
    | { safeParse: (value: unknown) => { success: boolean } }
    | undefined;
  expect(Answer).toBeDefined();
  const answers = Object.values(
    purge?.responses["200"]?.content?.["application/json"]?.examples ?? {},
  ).map(exampleValue);
  expect(answers.length).toBeGreaterThan(0);
  for (const answer of answers) {
    expect(Answer?.safeParse(answer).success).toBe(true);
  }
  expect(
    Answer?.safeParse({ deleted: { switchedOff: 2, removed: 0 } }).success,
  ).toBe(true);
  expect(Answer?.safeParse({ deleted: { switchedOff: 2 } }).success).toBe(
    false,
  );
  expect(
    Answer?.safeParse({ deleted: { switchedOff: -1, removed: 0 } }).success,
  ).toBe(false);
});

test("an administrator reads, without deleting anything, the two counts the purge would delete", () => {
  expect(unusable?.operationId).toBe("getUnusableSavedLogins");
  expect(unusable?.tags).toEqual(["Saved logins"]);
  expect(unusable?.requestBody).toBeUndefined();
  expect(unusable?.security).toContainEqual({
    appOAuth: ["saved-logins:read"],
  });
  expect(unusable?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(unusable?.responses["404"]?.$ref).toContain("OrganizationNotFound");
  expect(unusable?.description).toContain("personal edition");
  expect(unusable?.description).toContain("exactly what purgeSavedLogins");
});

test("the read's answer is the two counts, and every example the spec shows parses", () => {
  const Answer = (savedLogins as Record<string, unknown>)
    .GetUnusableSavedLoginsResponse as
    | { safeParse: (value: unknown) => { success: boolean } }
    | undefined;
  expect(Answer).toBeDefined();
  const answers = Object.values(
    unusable?.responses["200"]?.content?.["application/json"]?.examples ?? {},
  ).map(exampleValue);
  expect(answers.length).toBeGreaterThan(0);
  for (const answer of answers) {
    expect(Answer?.safeParse(answer).success).toBe(true);
  }
  expect(Answer?.safeParse({ switchedOff: 12, removed: 0 }).success).toBe(true);
  expect(Answer?.safeParse({ switchedOff: 12 }).success).toBe(false);
  expect(Answer?.safeParse({ switchedOff: 0, removed: -1 }).success).toBe(
    false,
  );
});

test("both say the removed group is a safety net, almost always 0", () => {
  for (const operation of [purge, unusable]) {
    expect(operation?.description).toContain("almost always 0");
  }
});
