import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";

/**
 * What one decision covers.
 *
 * A component is allowed by two grants: the Bot may use it, and it may read the data it draws. Both
 * are enforced when the data is fetched, which happens while the component renders. The decision is
 * asked before that, and answers whoever asked for the component, so it has to speak for the data
 * as well when the caller says which data that is.
 */

const GRANTED = "recentRefusals";
const WITHHELD = "botActivity";

const store = {
  decide: async () => ({ allowed: true as const, description: "Published." }),
  mayCall: async (_name: string, functionName: string) =>
    functionName === GRANTED,
} as unknown as ComponentStore;

const asSignedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "someone@openbot.test" });
  return next();
};

function app() {
  return new Hono().route(
    "/components",
    // These cover the decision itself, so every Bot here is one the caller may use. Whether they may
    // is `bot-access.test.ts`.
    createComponentRoutes(store, asSignedIn, undefined, async () => true),
  );
}

async function decide(body: Record<string, unknown>) {
  const response = await app().request(
    "http://openbot.local/components/showActivityReport/decision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return (await response.json()) as { allowed: boolean; reason?: string };
}

describe("deciding a component", () => {
  test("allows one whose Bot holds it and which names no data", async () => {
    expect(await decide({ agentId: "risk-analyst" })).toEqual({
      allowed: true,
    });
  });

  test("allows one whose data it may also read", async () => {
    expect(
      await decide({ agentId: "risk-analyst", functions: [GRANTED] }),
    ).toEqual({ allowed: true });
  });

  test("refuses one that would be drawn empty, and says which grant is missing", async () => {
    const decision = await decide({
      agentId: "risk-analyst",
      functions: [WITHHELD],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain(WITHHELD);
  });

  test("refuses when any one of the functions is withheld", async () => {
    const decision = await decide({
      agentId: "risk-analyst",
      functions: [GRANTED, WITHHELD],
    });
    expect(decision.allowed).toBe(false);
  });

  test("ignores anything in the list that is not a name", async () => {
    expect(
      await decide({ agentId: "risk-analyst", functions: [1, null, {}] }),
    ).toEqual({ allowed: true });
  });
});
