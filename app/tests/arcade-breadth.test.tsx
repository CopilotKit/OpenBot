import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BreadthNote } from "@/components/plugins/broker-directory";
import { consentBreadth } from "@/lib/plugins/enablement-notes";
import type { ComposioApp } from "@/lib/plugins/queries";
import fixture from "../../server/tests/fixtures/arcade-catalogue.json";

/**
 * The D32 consent-breadth line on the enablement screen. Derived from the three measured counts and
 * nothing else; `null` is not-measured and draws nothing, which is the opposite of a measured zero.
 */

type FixtureTool = {
  toolkit: { name: string };
  requirements?: { authorization?: { oauth2?: { scopes?: string[] } } };
};

/** The counts as the SERVER folds them (`listApps`): distinct non-empty sorted scope sets. */
function fromFixture(toolkit: string): ComposioApp {
  const tools = (Object.values(fixture.tools) as FixtureTool[]).filter(
    (tool) => tool.toolkit.name === toolkit,
  );
  const sets = tools
    .map((tool) => tool.requirements?.authorization?.oauth2?.scopes ?? [])
    .filter((scopes) => scopes.length > 0);
  return app({
    name: toolkit,
    actionCount: tools.length,
    permissionCount: new Set(sets.map((s) => [...s].sort().join(" "))).size,
    scopedActionCount: sets.length,
  });
}

function app(overrides: Partial<ComposioApp> = {}): ComposioApp {
  return {
    slug: "app",
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

/*
 * THE SINGULAR OF THE NO-PERMISSION CASE, which is the only branch that had none while its siblings
 * all did. Apollo is the fixture's one `permissionCount: 0` toolkit and it has exactly one action,
 * so the sentence that shipped read "approving any action in this app approves all 1 of them" — a
 * grammatical error on the single shape a real catalogue actually produces. Pinned to the exact
 * string, because `/approves/` is what let it through.
 */
test("Apollo (no permissions, one action) says the app is the action", () => {
  const apollo = fromFixture("Apollo");
  expect([apollo.permissionCount, apollo.actionCount]).toEqual([0, 1]);
  expect(consentBreadth(apollo)).toBe(
    "This app has a single action, and approving it approves the app.",
  );
});

test("the plural wholly-unscoped case says all N of them", () => {
  expect(
    consentBreadth(
      app({ actionCount: 43, permissionCount: 0, scopedActionCount: 0 }),
    ),
  ).toBe("Approving any action in this app approves all 43 of them.");
});

test("Asana and Attio are fully scoped: one permission across one action", () => {
  for (const name of ["Asana", "Attio"]) {
    const toolkit = fromFixture(name);
    expect([
      toolkit.permissionCount,
      toolkit.scopedActionCount,
      toolkit.actionCount,
    ]).toEqual([1, 1, 1]);
    expect(consentBreadth(toolkit)).toBe(
      "This app uses 1 separate permission across 1 action.",
    );
  }
});

test("more than one permission, fully scoped", () => {
  expect(
    consentBreadth(
      app({ actionCount: 30, permissionCount: 4, scopedActionCount: 30 }),
    ),
  ).toBe("This app uses 4 separate permissions across 30 actions.");
});

test("AirtableApi is the mixed shape: names the further K that need no permission", () => {
  const airtable = fromFixture("AirtableApi");
  expect([
    airtable.permissionCount,
    airtable.scopedActionCount,
    airtable.actionCount,
  ]).toEqual([1, 1, 2]);
  expect(consentBreadth(airtable)).toBe(
    "This app uses 1 separate permission across 2 actions. A further 1 requests no permission of its own and becomes callable with any approval here.",
  );
});

test("the mixed shape with several further actions", () => {
  expect(
    consentBreadth(
      app({ actionCount: 10, permissionCount: 2, scopedActionCount: 6 }),
    ),
  ).toBe(
    "This app uses 2 separate permissions across 10 actions. A further 4 request no permission of their own and become callable with any approval here.",
  );
});

test("any null count draws nothing, never a zero", () => {
  const measured = { permissionCount: 2, scopedActionCount: 2, actionCount: 2 };
  for (const nulled of ["permissionCount", "scopedActionCount"] as const) {
    const unmeasured = app({ ...measured, [nulled]: null });
    expect(consentBreadth(unmeasured)).toBeNull();
    expect(renderToStaticMarkup(<BreadthNote app={unmeasured} />)).toBe("");
  }
});

test("it renders on the enablement step, before enabling", () => {
  const html = renderToStaticMarkup(
    <BreadthNote
      app={app({ actionCount: 2, permissionCount: 1, scopedActionCount: 1 })}
    />,
  );
  expect(html).toContain('data-testid="breadth-note"');
  expect(html).toContain("1 separate permission across 2 actions");
});

test("no copy promises confinement", () => {
  const shapes = [
    app({ actionCount: 1, permissionCount: 0, scopedActionCount: 0 }),
    app({ actionCount: 3, permissionCount: 0, scopedActionCount: 0 }),
    app({ actionCount: 3, permissionCount: 2, scopedActionCount: 3 }),
    app({ actionCount: 3, permissionCount: 2, scopedActionCount: 1 }),
  ];
  for (const shape of shapes) {
    expect(consentBreadth(shape)).not.toMatch(
      /confin|only (the|that|this)|just (the|that|this)|limited to|isolat|least.privilege|restricted to|nothing else/i,
    );
  }
});
