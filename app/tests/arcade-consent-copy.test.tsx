import { expect, test } from "bun:test";
import {
  type ConsentAction,
  consentCopy,
} from "@/lib/plugins/enablement-notes";
import {
  consentActionsFrom,
  type GrantState,
  groupGrants,
} from "@/lib/plugins/grants";
import fixture from "../../server/tests/fixtures/arcade-catalogue.json";

/**
 * The copy shown before redirecting somebody to a consent screen (spec D30). The action list is
 * DERIVED by grouping on `scopes`; the fixture is evidence and is never appended to, so shapes it
 * does not carry (a shared scope across actions) are constructed inline.
 */

type FixtureTool = {
  qualified_name: string;
  toolkit: { name: string };
  requirements?: { authorization?: { oauth2?: { scopes?: string[] } } };
};

/**
 * The fixture rows an approval covers, as `ConsentAction`s. A row publishing no authorization block
 * (`Apollo`) is NOT one: nothing withholds it, so no approval approves it — the same line
 * `coveredByApproval` draws over the grants answer.
 */
function fromFixture(toolkit: string): ConsentAction[] {
  return (Object.values(fixture.tools) as FixtureTool[])
    .filter((tool) => tool.toolkit.name === toolkit)
    .filter((tool) => tool.requirements?.authorization != null)
    .map((tool) => ({
      name: tool.qualified_name,
      scopes: tool.requirements?.authorization?.oauth2?.scopes ?? [],
    }));
}

const gmail: ConsentAction[] = [
  { name: "Gmail.ListEmails", scopes: ["gmail.readonly"] },
  { name: "Gmail.ListThreads", scopes: ["gmail.readonly"] },
  { name: "Gmail.GetThread", scopes: ["gmail.readonly"] },
  { name: "Gmail.SendEmail", scopes: ["gmail.send"] },
];

test("scoped: names the permission and lists the actions grouped on that scope", () => {
  const copy = consentCopy("Gmail.ListEmails", gmail);
  expect(copy.scopes).toEqual(["gmail.readonly"]);
  expect(copy.alsoEnables).toEqual(["Gmail.GetThread", "Gmail.ListThreads"]);
  expect(copy.sentence).toContain("gmail.readonly");
  expect(copy.sentence).toContain("also enables");
  expect(copy.sentence).toContain("Gmail.GetThread, Gmail.ListThreads");
  expect(copy.sentence).not.toContain("Gmail.SendEmail");
  // The list follows the data: change a scope and the list changes with it.
  const moved = gmail.map((a) =>
    a.name === "Gmail.GetThread" ? { ...a, scopes: ["gmail.modify"] } : a,
  );
  expect(consentCopy("Gmail.ListEmails", moved).alsoEnables).toEqual([
    "Gmail.ListThreads",
  ]);
});

test("scoped, from the fixture: a lone scope set lists no sibling", () => {
  const asana = fromFixture("Asana");
  const copy = consentCopy(asana[0]!.name, asana);
  expect(copy.scopes).toEqual(["default"]);
  expect(copy.alsoEnables).toEqual([]);
  expect(copy.sentence).toContain("No other action requires it.");
});

test("unscoped: all-or-nothing, with the count derived", () => {
  // Apollo publishes no authorization at all, so there is nothing of it for an approval to cover.
  expect(fromFixture("Apollo")).toEqual([]);
  expect(
    consentCopy("Github.Only", [{ name: "Github.Only", scopes: [] }]).sentence,
  ).toContain("approving this approves its single action");
  const forty3 = Array.from({ length: 43 }, (_, i) => ({
    name: `Github.Action${i}`,
    scopes: [],
  }));
  expect(consentCopy("Github.Action0", forty3).sentence).toContain(
    "This app cannot separate permissions; approving this approves all 43.",
  );
  expect(consentCopy("Github.Action0", forty3.slice(0, 7)).sentence).toContain(
    "approves all 7.",
  );
});

test("an unscoped action in a scoped app is not worded as a permission", () => {
  const airtable = fromFixture("AirtableApi");
  const bare = airtable.find((a) => a.scopes.length === 0)!;
  const copy = consentCopy(bare.name, airtable);
  expect(copy.scopes).toEqual([]);
  expect(copy.sentence).toContain("requests no permission of its own");
});

test("no copy promises confinement", () => {
  const shapes = [
    consentCopy("Gmail.ListEmails", gmail),
    consentCopy("Gmail.SendEmail", gmail),
    consentCopy("Apollo.X", [{ name: "Apollo.X", scopes: [] }]),
    consentCopy(
      "G.A",
      Array.from({ length: 43 }, (_, i) => ({ name: `G.A${i}`, scopes: [] })),
    ),
    consentCopy("Missing", gmail),
  ];
  for (const shape of shapes) {
    expect(shape.sentence).not.toMatch(
      /confin|only (the|that|this)|just (the|that|this)|limited to|isolat|least.privilege|restricted to|nothing else/i,
    );
  }
});

/**
 * WHAT "N" MEANS in "approving this approves all N": the actions an approval genuinely covers —
 * those still waiting on one and those whose authorization is held — and never an action that needs
 * no authorization, which nothing withheld and no approval grants.
 *
 * Pinned against the COMPOSITION of the grants answer rather than a number: for every mix of
 * covered and no-auth actions, N is the covered count read off the fixture by its `authorization`
 * field, and adding no-auth actions never moves it. Counting the no-auth actions in — the drift the
 * server's reading of an absent authorization block once caused silently — reddens every row with
 * one or more of them.
 */
test("N counts what an approval covers, and no action that needs no authorization", () => {
  for (const covered of [2, 3, 5]) {
    for (const needsNone of [0, 1, 4]) {
      const grants: GrantState[] = [
        ...Array.from(
          { length: covered },
          (_, i): GrantState =>
            i % 2 === 0
              ? {
                  action: `Tk.Covered${i}`,
                  state: "needs-consent",
                  scopes: [],
                }
              : {
                  action: `Tk.Covered${i}`,
                  state: "authorized",
                  scopes: [],
                  authorization: "held",
                },
        ),
        ...Array.from(
          { length: needsNone },
          (_, i): GrantState => ({
            action: `Tk.Free${i}`,
            state: "authorized",
            scopes: [],
            authorization: "not-required",
          }),
        ),
        { action: "Tk.Blocked", state: "needs-operator", missing: ["KEY"] },
      ];
      const expected = grants.filter(
        (grant) =>
          grant.state === "needs-consent" ||
          (grant.state === "authorized" && grant.authorization === "held"),
      ).length;
      const actions = consentActionsFrom(grants);
      expect(actions.map((action) => action.name).sort()).toEqual(
        Array.from({ length: covered }, (_, i) => `Tk.Covered${i}`).sort(),
      );
      expect(consentCopy("Tk.Covered0", actions).sentence).toContain(
        `approving this approves all ${expected}.`,
      );
    }
  }
});

test("the whole-app group holds the same set the count does, and draws no-auth actions apart", () => {
  const grants: GrantState[] = [
    { action: "Tk.A", state: "needs-consent", scopes: [] },
    { action: "Tk.B", state: "authorized", scopes: [], authorization: "held" },
    {
      action: "Tk.Free",
      state: "authorized",
      scopes: [],
      authorization: "not-required",
    },
  ];
  const groups = groupGrants(grants);
  const together = groups.find((group) => group.kind === "whole-app");
  expect(together?.grants.map((grant) => grant.action).sort()).toEqual(
    consentActionsFrom(grants)
      .map((action) => action.name)
      .sort(),
  );
  expect(
    groups
      .find((group) => group.kind === "none")
      ?.grants.map((grant) => grant.action),
  ).toEqual(["Tk.Free"]);
});
