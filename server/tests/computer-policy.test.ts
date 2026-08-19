import { describe, expect, test } from "bun:test";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../src/computer/policy";
import { parseActionPolicy } from "../src/computer/policy-store";

/**
 * These test the decision, not the plumbing.
 *
 * Every case here is one a deployment can actually be in, and several are ones where the safe answer
 * is not the obvious one: a broken rule, an empty policy, a policy that is absent entirely. The
 * fail-closed paths are tested with the permissive path (`allow: ["true"]`) switched on, which proves
 * that denial still wins in the configuration deployments actually run.
 */

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: { name: "computer_click" },
    bot: { id: "risk-analyst" },
    actor: { id: "dev-local-user" },
    page: { url: "https://example.com/order", host: "example.com" },
    element: { ref: "e13", role: "button", name: "Submit order" },
    ...overrides,
  };
}

const permissive: ActionPolicy = {
  mode: "enforce",
  deny: [],
  ask: [],
  allow: ["true"],
};

describe("evaluateActionPolicy", () => {
  test("an absent policy refuses, rather than permitting everything", () => {
    const decision = evaluateActionPolicy(undefined, context());
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
    expect(decision.source).toBe("default");
  });

  test("an empty allow list refuses", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], ask: [], allow: [] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
  });

  test("deny beats allow, even when allow matches everything", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
    expect(decision.source).toBe("deny");
    // The reason is read by a person and names both the thing and the rule.
    expect(decision.reason).toContain("Submit order");
    expect(decision.reason).toContain("example.com");
  });

  test("a deny rule leaves unrelated elements alone", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context({ element: { ref: "e6", role: "input", name: "Large" } }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.forward).toBe(true);
  });

  test("substring matching is case-insensitive", () => {
    // A rule saying "never click submit" also catches uppercase button labels.
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context({ element: { ref: "e1", role: "button", name: "SUBMIT NOW" } }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("a BROKEN deny expression still denies", () => {
    // Fail-closed. A typo in a rule must not quietly permit the thing it was written to forbid, even
    // though `allow: ["true"]` would otherwise let it straight through.
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ["this is not ( valid cel"] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("deny");
  });

  test("a broken allow expression does not permit", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], ask: [], allow: ["also not ( valid"] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("default");
  });

  test("dry-run records a refusal but lets the work continue", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "dry-run",
        deny: ['contains(element.name, "submit")'],
        ask: [],
        allow: ["true"],
      },
      context(),
    );
    // Both halves matter: the trail must show it was refused, and the Bot must not be blocked.
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(true);
  });

  test("rules can be written against the tool, the host and the Bot", () => {
    const byTool = evaluateActionPolicy(
      { ...permissive, deny: ['tool.name == "computer_type"'] },
      context({ tool: { name: "computer_type" } }),
    );
    expect(byTool.allowed).toBe(false);

    const byHost = evaluateActionPolicy(
      { ...permissive, deny: ['page.host == "example.com"'] },
      context(),
    );
    expect(byHost.allowed).toBe(false);

    const byBot = evaluateActionPolicy(
      { ...permissive, deny: ['bot.id == "risk-analyst"'] },
      context(),
    );
    expect(byBot.allowed).toBe(false);
  });

  test("a rule about an element still decides when the element is unknown", () => {
    // An action on something the server could not resolve must be decided on, not waved through as
    // unrecognised. `contains` on a missing field throws, and a throwing deny expression denies.
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context({ element: undefined }),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("parseActionPolicy", () => {
  test("accepts a well-formed policy", () => {
    const result = parseActionPolicy({
      mode: "dry-run",
      deny: ['contains(element.name, "pay")'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.mode).toBe("dry-run");
      expect(result.policy.deny).toHaveLength(1);
    }
  });

  test("defaults the lists but never the mode", () => {
    const result = parseActionPolicy({ mode: "enforce" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.deny).toEqual([]);
      expect(result.policy.ask).toEqual([]);
      expect(result.policy.allow).toEqual([]);
    }
  });

  test("a policy written before the ask list existed still parses", () => {
    // Every deployment already running has a saved policy with two lists in it. Rejecting one, or
    // reading its absence as anything other than "asks nobody anything", would change what an
    // existing boundary means at the moment the server came back up.
    const result = parseActionPolicy({
      mode: "enforce",
      deny: ['contains(element.name, "pay")'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy.ask).toEqual([]);
  });

  test("keeps the ask rules it was given", () => {
    const result = parseActionPolicy({
      mode: "enforce",
      deny: [],
      ask: ['intent == "write_file"'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.policy.ask).toEqual(['intent == "write_file"']);
  });

  test("rejects an ask list that is not a list of expressions", () => {
    expect(parseActionPolicy({ mode: "enforce", ask: "everything" }).ok).toBe(
      false,
    );
    expect(parseActionPolicy({ mode: "enforce", ask: [7] }).ok).toBe(false);
  });

  test.each([
    ["not an object", "nonsense"],
    ["a missing mode", { deny: [], allow: [] }],
    ["an unknown mode", { mode: "advisory", deny: [], allow: [] }],
    ["a non-list deny", { mode: "enforce", deny: "everything" }],
    ["a list of non-strings", { mode: "enforce", allow: [1, 2] }],
  ])("rejects %s rather than coercing it", (_label, input) => {
    // Rejected, not repaired. An operator must never be told a rule was stored when it was stored
    // differently, because they would believe a restriction is in force when it is not.
    expect(parseActionPolicy(input).ok).toBe(false);
  });
});

describe("the second door", () => {
  test("a rule can refuse a keypress, not only a click", () => {
    // Form submission can happen through a keypress as well as a click, so policy must see both
    // activation paths.
    const policy = {
      mode: "enforce" as const,
      deny: ['tool.name == "computer_key" && key == "Enter"'],
      ask: [],
      allow: ["true"],
    };
    const refused = evaluateActionPolicy(policy, {
      tool: { name: "computer_key" },
      bot: { id: "sales" },
      actor: { id: "someone" },
      page: { url: "https://example.com/order", host: "example.com" },
      key: "Enter",
    });
    expect(refused.allowed).toBe(false);

    // And an ordinary keystroke still goes through, or the Bot could not type at all.
    const allowed = evaluateActionPolicy(policy, {
      tool: { name: "computer_key" },
      bot: { id: "sales" },
      actor: { id: "someone" },
      page: { url: "https://example.com/order", host: "example.com" },
      key: "a",
    });
    expect(allowed.allowed).toBe(true);
  });
});

/**
 * `intent` describes the effect rather than the mechanism. `tool.name` says which tool was used; an
 * operator writes rules about the action's effect, and a button can be pressed three different ways.
 */
describe("a rule written about what an action does", () => {
  const activate = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
    tool: { name: "computer_click" },
    bot: { id: "b" },
    actor: { id: "a" },
    page: { url: "https://example.com/", host: "example.com" },
    intent: "activate",
    ...extra,
  });

  const policy = {
    mode: "enforce" as const,
    deny: ['intent == "activate" && contains(element.name, "submit")'],
    ask: [],
    allow: ["true"],
  };

  test("catches the click on the button", () => {
    const decision = evaluateActionPolicy(
      policy,
      activate({
        element: { ref: "e1", role: "button", name: "Submit order" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("catches Enter pressed on the same button, which a rule about clicking did not", () => {
    const decision = evaluateActionPolicy(
      policy,
      activate({
        tool: { name: "computer_key" },
        key: "Enter",
        element: { ref: "e1", role: "button", name: "Submit order" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("catches Space on it too", () => {
    const decision = evaluateActionPolicy(
      policy,
      activate({
        tool: { name: "computer_key" },
        key: "Space",
        element: { ref: "e1", role: "button", name: "Submit order" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("leaves ordinary typing alone", () => {
    const decision = evaluateActionPolicy(policy, {
      ...activate(),
      tool: { name: "computer_type" },
      intent: "type",
      element: { ref: "e2", role: "textbox", name: "Customer name:" },
    });
    expect(decision.allowed).toBe(true);
  });

  /**
   * `intent` describes the addressed element, not the form submission side effect. A keypress in a
   * field submits the form, and the element it names is the field. Only a rule that refuses Enter
   * outright stops that, which is why the shipped preset still does.
   */
  test("does NOT catch Enter in a text field, which is why the preset also refuses Enter", () => {
    const inField = activate({
      tool: { name: "computer_key" },
      key: "Enter",
      element: { ref: "e3", role: "textbox", name: "E-mail address:" },
    });

    expect(evaluateActionPolicy(policy, inField).allowed).toBe(true);

    const withEnterRefused = {
      ...policy,
      deny: [...policy.deny, 'key == "Enter"'],
    };
    expect(evaluateActionPolicy(withEnterRefused, inField).allowed).toBe(false);
  });
});

/**
 * A rule about keypresses must not refuse everything else.
 *
 * `key` exists only on a keypress. An expression naming an absent identifier errors, and the engine
 * treats an error as a refusal, correctly, since a rule nobody can evaluate must not wave things
 * through. A bare `key == "Enter"` therefore refuses navigation too; scoped rules guard on the tool
 * name before reading key-specific fields.
 */
describe("a rule that names an identifier only some actions carry", () => {
  const navigating: PolicyContext = {
    tool: { name: "computer_navigate" },
    bot: { id: "b" },
    actor: { id: "a" },
    page: { url: "https://httpbin.org/forms/post", host: "httpbin.org" },
    intent: "navigate",
  };

  test("unguarded, it refuses a navigation that has no key at all", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['key == "Enter"'], ask: [], allow: ["true"] },
      navigating,
    );
    // Failing closed on an unevaluable rule is the safe answer. The shipped preset carries the guard
    // below to keep this rule scoped to keypresses.
    expect(decision.allowed).toBe(false);
  });

  test("guarded by the tool name, the navigation is allowed", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['tool.name == "computer_key" && key == "Enter"'],
        ask: [],
        allow: ["true"],
      },
      navigating,
    );
    expect(decision.allowed).toBe(true);
  });

  test("and the guarded rule still refuses the keypress it is about", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['tool.name == "computer_key" && key == "Enter"'],
        ask: [],
        allow: ["true"],
      },
      {
        ...navigating,
        tool: { name: "computer_key" },
        intent: "activate",
        key: "Enter",
        element: { ref: "e1", role: "textbox", name: "E-mail address:" },
      },
    );
    expect(decision.allowed).toBe(false);
  });
});

/**
 * The third answer, and the order it is asked in.
 *
 * Precedence is the whole design here and none of it is visible from the types. An ask that could
 * soften a deny would let a person wave through something a deployment forbade; an ask evaluated
 * after allow would never fire at all, because the shipped policy permits everything. Both mistakes
 * produce a rule that looks configured and does nothing anybody intended, so both are tested against
 * the permissive default deployments actually run.
 */
describe("asking a person", () => {
  const asking: ActionPolicy = {
    ...permissive,
    ask: ['contains(element.name, "submit")'],
  };

  test("an ask beats allow, in the configuration everybody ships with", () => {
    const decision = evaluateActionPolicy(asking, context());
    expect(decision.source).toBe("ask");
    expect(decision.allowed).toBe(false);
    // Nothing happens until somebody says so.
    expect(decision.forward).toBe(false);
    expect(decision.matched).toBe('contains(element.name, "submit")');
  });

  test("a deny beats an ask, so a forbidden thing is never offered as a question", () => {
    const decision = evaluateActionPolicy(
      { ...asking, deny: ['contains(element.name, "submit")'] },
      context(),
    );
    expect(decision.source).toBe("deny");
  });

  test("an ask rule leaves everything else alone", () => {
    const decision = evaluateActionPolicy(
      asking,
      context({ element: { ref: "e6", role: "input", name: "Quantity" } }),
    );
    expect(decision.source).toBe("allow");
    expect(decision.allowed).toBe(true);
  });

  test("a BROKEN ask expression asks, rather than quietly permitting", () => {
    // Fail-closed, the same way a broken deny denies. A typo in the rule interrupts somebody, which
    // is a nuisance; the alternative is that `allow: ["true"]` waves through exactly the action the
    // rule was written to hold back, and nothing anywhere says so.
    const decision = evaluateActionPolicy(
      { ...permissive, ask: ["this is not ( valid cel"] },
      context(),
    );
    expect(decision.source).toBe("ask");
    expect(decision.forward).toBe(false);
  });

  test("a rule about an element still asks when the element is unknown", () => {
    // `contains` on a missing field throws, and a throwing ask expression asks. An action on
    // something the server could not resolve is exactly the case a person should look at.
    const decision = evaluateActionPolicy(
      asking,
      context({ element: undefined }),
    );
    expect(decision.source).toBe("ask");
  });

  test("dry-run records the question and interrupts nobody", () => {
    // The promise of dry-run is that switching a policy on changes nothing, so an ask there is a note
    // saying where somebody would have been stopped, not a stop.
    const decision = evaluateActionPolicy(
      { ...asking, mode: "dry-run" },
      context(),
    );
    expect(decision.source).toBe("ask");
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(true);
  });

  test("the question names what is about to happen, and not the rule", () => {
    // The rule travels as its own field. A person answering a question about a button should not
    // have to read CEL to work out what they are agreeing to.
    const decision = evaluateActionPolicy(
      asking,
      context({ intent: "activate" }),
    );
    expect(decision.reason).toContain("Submit order");
    expect(decision.reason).toContain("example.com");
    expect(decision.reason).not.toContain("contains(");
  });

  test("a file question names the file rather than whatever page is open", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, ask: ['intent == "write_file"'] },
      context({
        tool: { name: "computer_write_file" },
        intent: "write_file",
        element: undefined,
        file: {
          path: "reports/august.csv",
          name: "august.csv",
          extension: "csv",
        },
      }),
    );
    expect(decision.reason).toContain("reports/august.csv");
    expect(decision.reason).not.toContain("example.com");
  });

  test("an empty allow list still refuses what nobody asked about", () => {
    // The floor is unchanged. An ask list is a third answer, not a way of turning default-deny into
    // default-ask: an action no rule mentions is still refused rather than put to somebody.
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: [],
        ask: ['tool.name == "computer_write_file"'],
        allow: [],
      },
      context(),
    );
    expect(decision.source).toBe("default");
    expect(decision.allowed).toBe(false);
  });
});
