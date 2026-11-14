import { afterAll, expect, test } from "bun:test";
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
