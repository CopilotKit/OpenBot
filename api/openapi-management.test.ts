import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * CopilotKit management. The screen shows only where the server says management applies, and it
 * learns that from one answer: getManagementEnrollment's 404 with the code MANAGEMENT_UNAVAILABLE on
 * the personal edition, OpenBot Cloud and any organization but `default`. The states are an open
 * list, so a later server can add one without breaking an app that reads this spec.
 */

type Operation = {
  operationId?: string;
  responses?: Record<string, { $ref?: string }>;
  parameters?: { $ref?: string }[];
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, { properties: Record<string, unknown> }>;
    responses: Record<
      string,
      {
        content: Record<
          string,
          { examples: Record<string, { value: { code: string } }> }
        >;
      }
    >;
  };
};

const base = "/api/v2/organizations/{organizationId}/management";

test("the three management operations sit at the addresses the screen and the agent's docs name", () => {
  expect(spec.paths[base]?.get?.operationId).toBe("getManagementEnrollment");
  expect(spec.paths[`${base}/enrollment`]?.post?.operationId).toBe(
    "startManagementEnrollment",
  );
  expect(spec.paths[`${base}/enrollment`]?.delete?.operationId).toBe(
    "cancelManagementEnrollment",
  );
});

test("each answers MANAGEMENT_UNAVAILABLE where management doesn't apply", () => {
  for (const operation of [
    spec.paths[base]?.get,
    spec.paths[`${base}/enrollment`]?.post,
    spec.paths[`${base}/enrollment`]?.delete,
  ]) {
    expect(operation?.responses?.["404"]?.$ref).toBe(
      "#/components/responses/ManagementUnavailable",
    );
  }
  const examples =
    spec.components.responses.ManagementUnavailable?.content[
      "application/problem+json"
    ]?.examples ?? {};
  expect(Object.values(examples).map((example) => example.value.code)).toEqual([
    "MANAGEMENT_UNAVAILABLE",
  ]);
});

test("the state is an open list a later server can add to", () => {
  expect(
    spec.components.schemas.ManagementEnrollment?.properties.state,
  ).toMatchObject({
    "x-extensible-enum": [
      "not-connected",
      "waiting-for-approval",
      "waiting-for-agent",
      "connected",
    ],
  });
});
