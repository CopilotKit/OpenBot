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
      "connecting",
      "opted-out",
    ],
  });
});

test("stopping a connection whose agent was uninstalled asks CopilotKit's service, so it can say the service is out of reach", () => {
  // Connected, Stop checks with the service whether the agent still reports in (it forgets the
  // connection only once it doesn't), so it can meet the same 502 as Connect.
  expect(
    spec.paths[`${base}/enrollment`]?.delete?.responses?.["502"]?.$ref,
  ).toBe("#/components/responses/ManagementServiceFailed");
});

test("the answer can carry the install's name and its maintenance window, and the not-entitled refusal's code", () => {
  const properties =
    spec.components.schemas.ManagementEnrollment?.properties ?? {};
  expect(Object.keys(properties)).toEqual(
    expect.arrayContaining(["installName", "window", "lastErrorCode"]),
  );
  expect(properties.lastErrorCode).toMatchObject({
    "x-extensible-enum": expect.arrayContaining(["not-entitled"]),
  });
});

test("connecting by licence: the answer says whether the chart installed the agent, and why the service refused", () => {
  // A team OpenBot whose chart installs the agent connects by itself; the screen needs to know
  // whether the agent is the chart's (no Helm command, Disconnect at once) and why a try failed.
  const properties =
    spec.components.schemas.ManagementEnrollment?.properties ?? {};
  expect(properties.agentInstalledByChart).toMatchObject({ type: "boolean" });
  expect(properties.upgrades).toMatchObject({
    "x-extensible-enum": ["on", "not-set-up"],
  });
  expect(properties.lastErrorCode).toMatchObject({
    "x-extensible-enum": ["not-entitled", "invalid-licence", "unreachable"],
  });
});

test("the answer says when the chart's agent went with OpenBot's release, so there is no Helm release to uninstall", () => {
  // Turning management off with Helm removes the agent the chart installed along with OpenBot's own
  // release. The screen must not then ask for `helm uninstall openbot-agent`, which has no release
  // to remove, while an agent installed as its own release still needs exactly that.
  const properties =
    spec.components.schemas.ManagementEnrollment?.properties ?? {};
  expect(properties.agentRemovedWithChart).toMatchObject({ type: "boolean" });
});
