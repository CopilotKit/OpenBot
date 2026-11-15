import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { skillFormSchema } from "../app/src/lib/skills/form";

/**
 * Components and skills: the rules the spec states that something else has to agree with. The skill
 * form checks a slug before it is sent, the server picks a scope by path for an app's token, and a
 * person who isn't an admin gets a component with the admin's fields empty.
 */

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  pattern?: string;
};
type Operation = {
  tags?: string[];
  operationId?: string;
  security?: Record<string, string[]>[];
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<string, { schema?: Schema }>;
    schemas: Record<string, Schema>;
    securitySchemes: {
      appOAuth: {
        flows: { authorizationCode: { scopes: Record<string, string> } };
      };
    };
  };
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;

const ORGANIZATION = "/api/v2/organizations/{organizationId}";
const METHODS = ["get", "put", "post", "patch", "delete"];

/** Every components and skills operation, with the one app scope it asks for. */
function operations() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method];
      const tag = operation?.tags?.find(
        (name) => name === "Components" || name === "Skills",
      );
      if (!operation || !tag) return [];
      const scopes = operation.security?.find(
        (entry) => entry.appOAuth,
      )?.appOAuth;
      return [{ path, method, tag, scopes }];
    }),
  );
}

test("a skill's slug is the one the skill form lets a person type", () => {
  const pattern = new RegExp(
    spec.components.parameters.SkillId?.schema?.pattern ?? "(?!)",
  );
  for (const slug of [
    "standup",
    "weekly-report",
    "a1",
    "x".repeat(40),
    "x".repeat(41),
    "a",
    "-standup",
    "standup-",
    "Standup",
    "stand_up",
    "stand up",
    "ünicode",
  ]) {
    expect({ slug, api: pattern.test(slug) }).toEqual({
      slug,
      api: skillFormSchema.shape.slug.safeParse(slug).success,
    });
  }
});

test("each operation asks for its own area's scope: reading to read, writing to change", () => {
  const found = operations();
  expect(found).toHaveLength(21);
  for (const { path, method, tag, scopes } of found) {
    const area = tag === "Skills" ? "skills" : "components";
    // Checking whether a Bot may draw a component, and reading its data, change nothing a person set.
    const reads = method === "get" || /\/(check|call)$/.test(path);
    expect({ path, method, scopes }).toEqual({
      path,
      method,
      scopes: [`${area}:${reads ? "read" : "write"}`],
    });
    expect(path.startsWith(`${ORGANIZATION}/`)).toBe(true);
  }
  const declared = Object.keys(
    spec.components.securitySchemes.appOAuth.flows.authorizationCode.scopes,
  );
  for (const scope of [
    "components:read",
    "components:write",
    "skills:read",
    "skills:write",
  ])
    expect(declared).toContain(scope);
});

test("the fields only an admin sees are always sent, and may be null", () => {
  const component = spec.components.schemas.Component;
  for (const field of [
    "draft",
    "hasUnpublishedChanges",
    "withheldFrom",
    "functions",
    "updatedBy",
  ]) {
    expect(component?.required).toContain(field);
    const property = component?.properties?.[field];
    const nullable =
      [property?.type].flat().includes("null") ||
      Boolean(property?.oneOf?.some((option) => option.type === "null"));
    expect({ field, nullable }).toEqual({ field, nullable: true });
  }
});
