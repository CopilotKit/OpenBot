import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Learning's proposals, their evidence, reviews and runs are read and changed in two places: an
 * administrator's, over the organization's spaces (settings/learning, picked with botId), and a
 * person's, over their own spaces (people/{personId}, picked with containerId). A screen shows the
 * same proposal either way, so these hold the two to the same shapes and the same way of picking a
 * space.
 */

type Parameter = { $ref?: string; name?: string; in?: string };
type Response = {
  $ref?: string;
  content?: Record<string, { schema?: { $ref?: string } }>;
};
type Operation = {
  operationId: string;
  parameters?: Parameter[];
  responses: Record<string, Response>;
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { parameters: Record<string, Parameter> };
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;

/** One operation, found by its id, with the schema its success answers in. */
function operation(operationId: string) {
  for (const item of Object.values(spec.paths))
    for (const candidate of Object.values(item))
      if (candidate?.operationId === operationId) {
        const success = Object.entries(candidate.responses).find(([status]) =>
          status.startsWith("2"),
        )?.[1];
        const schema = success?.content?.["application/json"]?.schema?.$ref;
        const query = (candidate.parameters ?? [])
          .map((parameter) =>
            parameter.$ref
              ? spec.components.parameters[
                  parameter.$ref.split("/").at(-1) ?? ""
                ]
              : parameter,
          )
          .filter((parameter) => parameter?.in === "query")
          .map((parameter) => String(parameter?.name));
        return { schema, query };
      }
  throw new Error(`No operation ${operationId}.`);
}

const PAIRS = [
  ["getLearningProposal", "getPersonLearningProposal"],
  ["approveLearningProposal", "approvePersonLearningProposal"],
  ["rejectLearningProposal", "rejectPersonLearningProposal"],
  ["getLearningEvidence", "getPersonLearningEvidence"],
  ["startOrganizationLearningRun", "startPersonLearningRun"],
] as const;

test("an organization's space and a person's own answer in the same shapes", () => {
  for (const [organization, person] of PAIRS)
    expect(operation(person).schema).toBe(operation(organization).schema);
});

test("the organization's spaces are picked by Bot, and a person's by space", () => {
  for (const [organization, person] of PAIRS) {
    expect(operation(organization).query).toContain("botId");
    expect(operation(person).query).toContain("containerId");
  }
  expect(operation("listLearningProposals").query).toContain("botId");
  expect(operation("listOrganizationLearningRuns").query).toContain("botId");
});
