import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditReader } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { type ActionPolicy, checkPolicyRule } from "../src/computer/policy";
import {
  createPolicyStore,
  type PolicyStore,
} from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * A boundary rule is compiled before it is saved or replayed.
 *
 * A save used to check only that each rule was text. A deny rule that cannot be evaluated counts as a
 * match (fail closed), so a typo saved on the Boundaries page refused every action every Bot took, and
 * the preview of it showed it stopping everything. The rules below are the ones people write: the
 * shipped preset and templates, the examples in the design, and the slips that turn up in them.
 */

const SHIPPED = [
  // AGENT_COMPUTER_POLICY in .env.example, and the "Never submit a form" template.
  '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && intent == "activate")',
  'intent == "type" && contains(element.name, "password")',
  'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
  // The design's examples, and the rule people write about apps.
  'initiator.kind == "routine" && intent == "run_command"',
  'contains(command, "rm -rf")',
  'mcp.server == "salesforce" && mcp.effect == "write"',
  'file.extension == "env" || matches(file.path, "^credentials/")',
  "tool.name == 'computer_click' && has(element.name)",
  "true",
];

describe("checkPolicyRule", () => {
  test.each(SHIPPED)("accepts %s", (rule) => {
    expect(checkPolicyRule(rule)).toEqual({ ok: true });
  });

  test.each([
    ['mcp.server == "salesforce" &&', "stops before it's finished"],
    ['contains(element.name, "Submit"', "stops before it's finished"],
    ['mcp.server = "salesforce"', "Use == to compare"],
    ["Submit order", '"order" where it doesn\'t fit'],
  ])("refuses the typo %s, saying why", (rule, why) => {
    const checked = checkPolicyRule(rule);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toContain(why);
  });

  test.each([
    ['elemnt.name == "Submit"', 'can\'t check "elemnt"'],
    ['mcp.sever == "salesforce"', 'can\'t check "mcp.sever". mcp has server'],
    ['command.text == "rm"', 'can\'t check "command.text"'],
    [
      'element.name.contains("Submit")',
      'Write contains(element.name, "…"), not element.name.contains',
    ],
    ['startsWith(page.url, "https://")', "can't use startsWith()"],
  ])(
    "refuses a variable or function the evaluator doesn't have: %s",
    (rule, why) => {
      const checked = checkPolicyRule(rule);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.error).toContain(why);
    },
  );

  test("finds a wrong variable that evaluation alone would never reach", () => {
    // `&&` stops at its first false, so against an action that isn't a keypress the misspelt half is
    // never evaluated. Against every keypress it throws, fails closed, and refuses.
    const checked = checkPolicyRule(
      'tool.name == "computer_key" && elemnt.name == "Submit"',
    );
    expect(checked).toEqual({
      ok: false,
      error: expect.stringContaining('can\'t check "elemnt"'),
    });
  });

  test("refuses a rule that answers something other than true or false", () => {
    // Somebody who reads the deny list as a list of labels writes the label.
    expect(checkPolicyRule('"Submit order"')).toEqual({
      ok: false,
      error: expect.stringContaining("not true or false"),
    });
    expect(checkPolicyRule("   ")).toEqual({
      ok: false,
      error: "A rule can't be empty.",
    });
  });
});

const ADMIN = { id: "u1", email: "admin@openbot.test", role: "admin" } as const;
const ALLOW_ALL: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

function app(store: PolicyStore, reader?: AuditReader) {
  const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    await next();
  };
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    createComputerRoutes(
      {} as never,
      store,
      asAdmin,
      async () => false,
      undefined,
      reader,
    ),
  );
}

const request = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("saving a boundary", () => {
  test("a rule that compiles is saved", async () => {
    const store = createPolicyStore(ALLOW_ALL);
    const rule = 'mcp.server == "salesforce" && mcp.effect == "write"';
    const response = await app(store).request(
      "http://t/api/computers/policy",
      request("PUT", { ...ALLOW_ALL, deny: [rule] }),
    );
    expect(response.status).toBe(200);
    expect(store.get().deny).toEqual([rule]);
  });

  test.each([
    ['mcp.server == "salesforce" &&', "stops before it's finished"],
    ['elemnt.name == "Submit"', 'can\'t check "elemnt"'],
    ['mcp.sever == "salesforce"', 'can\'t check "mcp.sever"'],
  ])(
    "a rule that doesn't compile is refused with the rule and why, and nothing is saved: %s",
    async (rule, why) => {
      const store = createPolicyStore(ALLOW_ALL);
      const response = await app(store).request(
        "http://t/api/computers/policy",
        request("PUT", { ...ALLOW_ALL, deny: [rule] }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; rule: string };
      expect(body.rule).toBe(rule);
      expect(body.error).toContain(why);
      expect(store.get()).toEqual(ALLOW_ALL);
    },
  );

  test("an allow rule is checked too", async () => {
    const store = createPolicyStore(ALLOW_ALL);
    const response = await app(store).request(
      "http://t/api/computers/policy",
      request("PUT", { mode: "enforce", deny: [], allow: ['bot.name == "x"'] }),
    );
    expect(response.status).toBe(400);
  });

  test("a broken rule already in force doesn't block removing another, or switching trial mode", async () => {
    // Two rules saved before this check existed, or set in configuration. Refusing every save that
    // keeps one would leave no way to remove either from the screen.
    const broken = ['elemnt.name == "a"', 'mcp.sever == "b"'];
    const store = createPolicyStore({ ...ALLOW_ALL, deny: broken });
    const removed = await app(store).request(
      "http://t/api/computers/policy",
      request("PUT", { ...ALLOW_ALL, deny: [broken[1]] }),
    );
    expect(removed.status).toBe(200);
    const trial = await app(store).request(
      "http://t/api/computers/policy",
      request("PUT", { ...ALLOW_ALL, mode: "dry-run", deny: [broken[1]] }),
    );
    expect(trial.status).toBe(200);
    expect(store.get()).toMatchObject({ mode: "dry-run", deny: [broken[1]] });
  });
});

describe("the dry-run of a rule that doesn't compile", () => {
  test("reports the rule and why, and replays nothing", async () => {
    let read = 0;
    const reader = {
      list: async () => {
        read += 1;
        return { events: [] };
      },
    } as AuditReader;
    const rule = 'contains(element.name, "Submit"';
    const response = await app(createPolicyStore(ALLOW_ALL), reader).request(
      "http://t/api/computers/policy-dry-run",
      request("POST", { policy: { ...ALLOW_ALL, deny: [rule] } }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("stops before it's finished"),
      rule,
    });
    expect(read).toBe(0);
  });
});
