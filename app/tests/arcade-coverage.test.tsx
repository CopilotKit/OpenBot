import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageNote } from "@/components/plugins/broker-directory";
import { coverageWarning } from "@/lib/plugins/enablement-notes";
import type { ComposioApp } from "@/lib/plugins/queries";
import fixture from "../../server/tests/fixtures/arcade-catalogue.json";

/**
 * The D8 coverage warning on the enablement screen. Driven by `classifiedCount` against
 * `actionCount` and nothing else: `0` is measured-and-none (warn), `null` is not measured (silent).
 */

type FixtureTool = {
  toolkit: { name: string };
  metadata?: { behavior?: unknown };
};

/**
 * The counts for a toolkit as the SERVER would have measured them. The fixture is evidence of what
 * Arcade returns; this folds it the way `listApps` does (a tool is classified when it carries
 * behavior metadata), so the app under test is built from real tools, not a literal.
 */
function fromFixture(toolkit: string): ComposioApp {
  const tools = (Object.values(fixture.tools) as FixtureTool[]).filter(
    (tool) => tool.toolkit.name === toolkit,
  );
  return app({
    slug: toolkit.toLowerCase(),
    name: toolkit,
    actionCount: tools.length,
    classifiedCount: tools.filter((tool) => tool.metadata?.behavior).length,
  });
}

function app(overrides: Partial<ComposioApp> & { slug: string }): ComposioApp {
  return {
    name: "App",
    description: "",
    logo: null,
    categories: [],
    actionCount: 1,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    enabled: false,
    ...overrides,
  };
}

test("the curated toolkit Apollo (1/1 classified) shows no warning", () => {
  const apollo = fromFixture("Apollo");
  expect([apollo.classifiedCount, apollo.actionCount]).toEqual([1, 1]);
  expect(coverageWarning(apollo)).toBeNull();
  expect(renderToStaticMarkup(<CoverageNote app={apollo} />)).toBe("");
});

test("the generated toolkit AirtableApi (0/2 classified) renders the warning on its row", () => {
  const airtable = fromFixture("AirtableApi");
  expect([airtable.classifiedCount, airtable.actionCount]).toEqual([0, 2]);
  expect(coverageWarning(airtable)).toMatch(/destructive write/);
  expect(renderToStaticMarkup(<CoverageNote app={airtable} />)).toContain(
    "approval",
  );
  // Phrased as what it feels like, never as a percentage.
  expect(coverageWarning(airtable)).not.toMatch(/%|\d/);
});

test("a 0-classified toolkit renamed WITHOUT the Api suffix still warns", () => {
  const renamed = { ...fromFixture("AirtableApi"), name: "Airtable" };
  expect(coverageWarning(renamed)).not.toBeNull();
});

test("a classified toolkit WITH the Api suffix does not warn", () => {
  expect(
    coverageWarning(
      app({
        slug: "x",
        name: "DatadogApi",
        actionCount: 5,
        classifiedCount: 5,
      }),
    ),
  ).toBeNull();
});

test("classifiedCount null draws nothing", () => {
  const unmeasured = app({ slug: "s", name: "SlackApi", actionCount: 40 });
  expect(coverageWarning(unmeasured)).toBeNull();
  expect(renderToStaticMarkup(<CoverageNote app={unmeasured} />)).toBe("");
});

test("a measured zero over no actions is not a warning", () => {
  expect(
    coverageWarning(app({ slug: "e", actionCount: 0, classifiedCount: 0 })),
  ).toBeNull();
});
