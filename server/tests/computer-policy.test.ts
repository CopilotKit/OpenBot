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

const permissive: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

describe("evaluateActionPolicy", () => {
  test("an absent policy refuses, rather than permitting everything", () => {
    const decision = evaluateActionPolicy(undefined, context());
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
    expect(decision.source).toBe("default");
  });

  test("an empty allow list refuses", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], allow: [] },
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

  // The other way a rule is broken. These parse and evaluate, so nothing throws; they simply do not
  // answer the question that was asked, and the only safe reading of a deny rule that did not answer
  // is that it denied. `"Submit order"` is what somebody writes who thinks the list takes labels
  // rather than expressions, and it is a valid CEL string.
  test.each([
    ['"Submit order"', "a bare string, i.e. the list read as labels"],
    ["element.name", "a bare field reference"],
    ['contains(element.name, "submit") ? element.name : false', "a ternary"],
    ["repeat.count", "a number"],
  ])(
    "a deny expression that is not a question (%s: %s) still denies",
    (rule) => {
      const decision = evaluateActionPolicy(
        { ...permissive, deny: [rule] },
        context(),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.source).toBe("deny");
    },
  );

  // The mirror. A rule that does not answer must not permit either, which is what this already did by
  // reading anything other than true as no match.
  test("an allow expression that is not a question does not permit", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], allow: ['"Submit order"'] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("default");
  });

  // A rule that answers "no" is not broken, and must not be read as one: a deny list where every
  // false reading became a denial would refuse everything.
  test("a deny expression that answers false permits", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "cancel")'] },
      context(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("allow");
  });

  test("a broken allow expression does not permit", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], allow: ["also not ( valid"] },
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
      expect(result.policy.allow).toEqual([]);
    }
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
      { mode: "enforce", deny: ['key == "Enter"'], allow: ["true"] },
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
 * What a refusal says it refused.
 *
 * A tool call carries every browser field the engine knows about, all of them empty, so that a rule
 * written about a page evaluates to false against it rather than being unevaluable. That is correct
 * for the decision and wrong for the sentence: each of those empty fields is present, so a refusal
 * described from them names a page nobody visited or a file nobody touched.
 */
describe("describing a refusal", () => {
  const mcpContext: PolicyContext = {
    tool: { name: "mcp__notes__search_notes" },
    bot: { id: "knowledge" },
    actor: { id: "dev-local-user" },
    page: { url: "", host: "" },
    element: { ref: "", role: "", name: "", type: "" },
    key: "",
    file: { path: "", name: "", extension: "" },
    mcp: { server: "notes", tool: "search_notes", effect: "read" },
  };

  test("a refused tool call names the tool and the server it was aimed at", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['mcp.server == "notes"'], allow: ["true"] },
      mcpContext,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(
      'This deployment\'s policy does not allow that: search_notes on notes is blocked by the rule `mcp.server == "notes"`.',
    );
    // The neutral file field is present and empty on every tool call. Described from it, the
    // sentence read "the file  is blocked", naming a workspace the call never went near.
    expect(decision.reason).not.toContain("the file");
  });

  test("a refused file action still names the file", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['contains(file.path, "secrets")'],
        allow: ["true"],
      },
      context({
        tool: { name: "computer_read_file" },
        file: {
          path: "/workspace/secrets.env",
          name: "secrets.env",
          extension: "env",
        },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("the file /workspace/secrets.env");
  });
});

/**
 * A shell command, judged like any other action.
 *
 * The blunt rule matters more than the clever one here. A deployment that does not want its Bots
 * running commands says so once with `intent`, and does not have to imagine every command it would
 * have wanted to refuse.
 */
describe("commands", () => {
  const runCommand = (command: string): PolicyContext => ({
    tool: { name: "computer_run_command" },
    bot: { id: "general-assistant" },
    actor: { id: "dev-local-user" },
    page: { url: "", host: "" },
    intent: "run_command",
    command,
  });

  test("a deployment can refuse the shell outright", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['intent == "run_command"'], allow: ["true"] },
      runCommand("apt-get install -y jq"),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.matched).toBe('intent == "run_command"');
  });

  test("a rule can name what the command says", () => {
    const policy = {
      mode: "enforce" as const,
      deny: ['contains(command, "rm -rf")'],
      allow: ["true"],
    };
    expect(evaluateActionPolicy(policy, runCommand("rm -rf /")).allowed).toBe(
      false,
    );
    expect(evaluateActionPolicy(policy, runCommand("ls -la")).allowed).toBe(
      true,
    );
  });

  test("commands are allowed when nothing refuses them", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: [], allow: ["true"] },
      runCommand("echo hello"),
    );
    expect(decision.allowed).toBe(true);
  });

  /*
   * A rule written about the browser must not catch a command. The neutral empty fields make
   * `page.host` and the element fields evaluate to false rather than being unevaluable, which is
   * what keeps the shipped deny preset from refusing every command a Bot ever runs.
   */
  test("a browser rule does not refuse a command", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['contains(element.name, "submit") || key == "Enter"'],
        allow: ["true"],
      },
      {
        ...runCommand("echo hello"),
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
      },
    );
    expect(decision.allowed).toBe(true);
  });
});

/**
 * A boundary drawn around one acting surface must leave the others alone.
 *
 * Each surface builds the context it owns and carries the other surfaces' fields at their neutral,
 * matches-nothing value — the browser context a neutral `mcp`, the MCP context a neutral `command` —
 * so a rule naming another surface's field evaluates to false rather than throwing. An unbound field
 * throws, and a thrown rule fails closed, so without this a `deny: mcp.effect == "write"` would refuse
 * every browser click and a `deny: contains(command, "rm")` every MCP call: an operator forbidding one
 * thing would silently forbid another, and could not reason about what they had done.
 */
describe("a rule about one surface does not refuse another", () => {
  // The shapes the gateway and the MCP path actually build, including the neutral cross-surface fields.
  const browserAction: PolicyContext = {
    tool: { name: "computer_click" },
    bot: { id: "b" },
    actor: { id: "a" },
    page: { url: "https://example.com", host: "example.com" },
    intent: "activate",
    element: { ref: "e1", role: "button", name: "Open", type: "" },
    key: "",
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "", tool: "", effect: "" },
  };
  const mcpAction: PolicyContext = {
    tool: { name: "mcp__jira__getIssue" },
    bot: { id: "b" },
    actor: { id: "a" },
    page: { url: "", host: "" },
    intent: "read_tool",
    element: { ref: "", role: "", name: "", type: "" },
    key: "",
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "jira", tool: "getIssue", effect: "read" },
  };

  test("an MCP deny rule leaves a browser action alone", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['mcp.effect == "write"'], allow: ["true"] },
      browserAction,
    );
    expect(decision.allowed).toBe(true);
  });

  test("neither an MCP read nor an MCP write rule catches a browser action", () => {
    for (const rule of ['mcp.effect == "read"', 'mcp.effect == "write"']) {
      const decision = evaluateActionPolicy(
        { mode: "enforce", deny: [rule], allow: ["true"] },
        browserAction,
      );
      expect(decision.allowed).toBe(true);
    }
  });

  test("a shell-command deny rule leaves an MCP call alone", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['contains(command, "rm -rf")'],
        allow: ["true"],
      },
      mcpAction,
    );
    expect(decision.allowed).toBe(true);
  });

  test("the MCP rule still refuses a real MCP write", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['mcp.effect == "write"'], allow: ["true"] },
      {
        ...mcpAction,
        intent: "write_tool",
        mcp: { server: "jira", tool: "editIssue", effect: "write" },
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("deny");
  });

  test("the shell rule still refuses a real command", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['contains(command, "rm -rf")'],
        allow: ["true"],
      },
      {
        ...browserAction,
        tool: { name: "computer_run_command" },
        intent: "run_command",
        command: "rm -rf /",
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("deny");
  });
});
