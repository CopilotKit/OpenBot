import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The list of a person's own organizations, as an app's token reads it. A token carries no session,
 * so the OpenBot-Organization header says which organization it works in, and the list marks that
 * one active. The header is checked against the person's membership as on every address that names
 * no organization, so one they are not in answers not found. The spec declares both, so a client
 * generated from it knows the header and the answer.
 */

type Parameter = {
  name?: string;
  in?: string;
  required?: boolean;
  $ref?: string;
};
type Operation = {
  parameters?: Parameter[];
  responses?: Record<string, { $ref?: string }>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: { parameters: Record<string, Parameter> };
};

const listOrganizations = spec.paths["/api/v2/people/me/organizations"]?.get;

const parameters = (listOrganizations?.parameters ?? []).map((parameter) =>
  parameter.$ref
    ? spec.components.parameters[
        parameter.$ref.replace("#/components/parameters/", "")
      ]
    : parameter,
);

test("listOrganizations declares the header an app's token names its organization with", () => {
  expect(
    parameters.find((parameter) => parameter?.name === "OpenBot-Organization"),
  ).toMatchObject({ in: "header", required: false });
});

test("listOrganizations declares the not found a header naming an organization the caller isn't in answers", () => {
  expect(listOrganizations?.responses?.["404"]?.$ref).toBe(
    "#/components/responses/OrganizationNotFound",
  );
});
