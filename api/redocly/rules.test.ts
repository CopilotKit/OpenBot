import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/**
 * `redocly lint` with this repository's config refuses a spec that breaks OpenBot's API conventions.
 *
 * Run through the CLI CI runs, on a copy of api/openapi.yaml with one break per convention, so a rule
 * that stops firing (a plugin that fails to load, a visitor that never matches) fails here rather
 * than letting the break through review.
 */

/*
 * Each lint is one run of the CLI over the whole spec: about 1 s on a laptop and 2.4 to 2.7 s on a CI
 * runner, so a test that lints twice took 4.7 s there and one ran past Bun's 5 s default. Twenty
 * seconds is four times the slowest seen.
 */
setDefaultTimeout(20_000);

const ROOT = join(import.meta.dir, "../..");
const SPEC = join(ROOT, "api/openapi.yaml");
const work = mkdtempSync(join(tmpdir(), "openbot-api-lint-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Problem = { ruleId: string; message: string };

function lint(document: unknown): Problem[] {
  const file = join(work, `spec-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, stringify(document));
  const run = Bun.spawnSync(
    [
      join(ROOT, "node_modules/.bin/redocly"),
      "lint",
      file,
      "--config",
      join(ROOT, "redocly.yaml"),
      "--format=json",
    ],
    { cwd: ROOT, env: { ...process.env, REDOCLY_TELEMETRY: "off" } },
  );
  const output = run.stdout.toString();
  const report = JSON.parse(output.slice(output.indexOf("{"))) as {
    problems: Problem[];
  };
  return report.problems;
}

const spec = () => parse(readFileSync(SPEC, "utf8"));
const BOTS = "/api/v2/organizations/{organizationId}/bots";

test("the spec as committed passes", () => {
  expect(lint(spec())).toEqual([]);
});

test("each convention is enforced", () => {
  const broken = spec();
  // A path Intelligence serves, by name and by family.
  broken.paths["/api/v2/organizations/{organizationId}/threads"] =
    broken.paths[BOTS];
  broken.paths["/api/v2/organizations/{organizationId}/learning-runs"] =
    broken.paths[BOTS];
  // A path outside the organization.
  broken.paths["/api/bots"] = broken.paths[BOTS];
  // A write with no Idempotency-Key.
  broken.paths[`${BOTS}/{botId}`].patch.parameters = [];
  // An error that is not problem details.
  broken.paths[`${BOTS}/{botId}`].get.responses["404"] = {
    description: "Not found.",
    content: {
      "application/json": { schema: { type: "object" } },
    },
  };
  // A list that does not page.
  broken.paths[BOTS].get.parameters = broken.paths[BOTS].get.parameters.filter(
    (parameter: { $ref?: string }) =>
      parameter.$ref !== "#/components/parameters/Cursor",
  );
  // Not OpenAPI 3.1.
  broken.openapi = "3.0.3";

  const rules = new Set(lint(broken).map((problem) => problem.ruleId));
  for (const rule of [
    "openbot/no-intelligence-collision",
    "openbot/organization-scoped",
    "openbot/idempotency-key-on-writes",
    "openbot/problem-details-errors",
    "openbot/cursor-paging",
    "openbot/openapi-3-1",
  ]) {
    expect(rules).toContain(rule);
  }
});

test("only the caller's own organizations and invitations sit outside an organization", () => {
  const ORGANIZATIONS = "/api/v2/people/me/organizations";
  // What a person can ask before they can name an organization, or before they are a member of
  // the one an invitation is for: allowed as committed.
  expect(Object.keys(spec().paths)).toContain(ORGANIZATIONS);
  expect(Object.keys(spec().paths)).toContain(
    "/api/v2/people/me/invitations/{invitationId}/accept",
  );
  const broken = spec();
  // Nothing beside it is: not another of the person's own resources, and not the address under it.
  broken.paths["/api/v2/people/me/bots"] = broken.paths[BOTS];
  broken.paths[`${ORGANIZATIONS}/{organizationId}`] = broken.paths[BOTS];
  const outside = lint(broken)
    .filter((problem) => problem.ruleId === "openbot/organization-scoped")
    .map((problem) => problem.message);
  expect(outside).toHaveLength(2);
  expect(
    outside.some((text) =>
      text.startsWith("/api/v2/people/me/bots is not under"),
    ),
  ).toBe(true);
  expect(
    outside.some((text) =>
      text.startsWith(`${ORGANIZATIONS}/{organizationId} is not under`),
    ),
  ).toBe(true);
});

test("an area's own problem must be the shared one and more", () => {
  const extended = spec();
  extended.components.schemas.ThingProblem = {
    allOf: [
      { $ref: "#/components/schemas/Problem" },
      { type: "object", properties: { thing: { type: "string" } } },
    ],
  };
  const problem = (schema: string) => ({
    description: "Not found.",
    content: {
      "application/problem+json": { schema: { $ref: schema } },
    },
  });
  extended.paths[`${BOTS}/{botId}`].get.responses["404"] = problem(
    "#/components/schemas/ThingProblem",
  );
  expect(
    lint(extended).filter(
      (found) => found.ruleId === "openbot/problem-details-errors",
    ),
  ).toEqual([]);

  // One that only looks like a problem is still refused.
  extended.components.schemas.ThingProblem = {
    type: "object",
    properties: { detail: { type: "string" } },
  };
  expect(lint(extended).map((found) => found.ruleId)).toContain(
    "openbot/problem-details-errors",
  );
});

test("a collision names what Intelligence owns", () => {
  const broken = spec();
  broken.paths["/api/v2/organizations/{organizationId}/memory-sources"] =
    broken.paths[BOTS];
  broken.paths["/api/v2/runtime/bots"] = broken.paths[BOTS];
  const messages = lint(broken)
    .filter((problem) => problem.ruleId === "openbot/no-intelligence-collision")
    .map((problem) => problem.message);
  expect(
    messages.some((text) => text.includes("Intelligence's memory-sources")),
  ).toBe(true);
  expect(
    messages.some((text) => text.includes("Intelligence's /api/v2/runtime")),
  ).toBe(true);
});

test("an error may be a problem type that extends the shared Problem, and nothing looser", () => {
  const extended = spec();
  extended.components.schemas.WidgetProblem = {
    allOf: [
      { $ref: "#/components/schemas/Problem" },
      { type: "object", properties: { widgetId: { type: "string" } } },
    ],
  };
  const notFound = (schema: unknown) => ({
    description: "Not found.",
    content: { "application/problem+json": { schema } },
  });
  extended.paths[`${BOTS}/{botId}`].get.responses["404"] = notFound({
    $ref: "#/components/schemas/WidgetProblem",
  });
  expect(
    lint(extended).filter(
      (problem) => problem.ruleId === "openbot/problem-details-errors",
    ),
  ).toEqual([]);

  // A schema of its own that does not start from the shared Problem is not problem details.
  const loose = spec();
  loose.components.schemas.WidgetProblem = {
    type: "object",
    properties: { widgetId: { type: "string" } },
  };
  loose.paths[`${BOTS}/{botId}`].get.responses["404"] = notFound({
    $ref: "#/components/schemas/WidgetProblem",
  });
  expect(lint(loose).map((problem) => problem.ruleId)).toContain(
    "openbot/problem-details-errors",
  );
});
