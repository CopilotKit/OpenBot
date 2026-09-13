import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";

/**
 * A governance question must be answered about what was asked.
 *
 * The route used to filter non-string `functions` out, so asking about `[123, null, {}]`
 * became asking about `[]`: the loop never ran and the answer was `allowed: true`. A
 * caller that meant "may it call X, Y" got "yes" because X and Y were not strings. A
 * whitespace Bot id had the same shape problem one line up: `"   "` passed the presence
 * check and fell through to a 404 instead of the 400 a blank Bot deserves.
 */

const GRANTED = "recentRefusals";
const WITHHELD = "botActivity";

function harness() {
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

  const hono = new Hono().route(
    "/components",
    createComponentRoutes(store, asSignedIn, undefined, async () => true),
  );
  return hono;
}

async function post(body: unknown) {
  const response = await harness().request(
    "http://t/components/showActivityReport/decision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, json: (await response.json()) as unknown };
}

describe("deciding a component with functions", () => {
  test("allows a granted function", async () => {
    expect(
      await post({ agentId: "risk-analyst", functions: [GRANTED] }),
    ).toEqual({
      status: 200,
      json: { allowed: true },
    });
  });

  test("refuses a withheld function and names it", async () => {
    const result = await post({
      agentId: "risk-analyst",
      functions: [WITHHELD],
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ allowed: false });
    expect(JSON.stringify(result.json)).toContain(WITHHELD);
  });

  test("an absent functions list still asks about the component alone", async () => {
    expect(await post({ agentId: "risk-analyst" })).toEqual({
      status: 200,
      json: { allowed: true },
    });
  });

  test("a padded Bot id is read for the Bot it names", async () => {
    expect(await post({ agentId: "  risk-analyst  " })).toEqual({
      status: 200,
      json: { allowed: true },
    });
  });

  test.each([[null], [123], ["   "], ["\n\t "]])(
    "refuses a blank Bot id %p with 400",
    async (agentId) => {
      const result = await post({ agentId });
      expect(result.status).toBe(400);
      expect(result.json).toEqual({ error: "The Bot is required." });
    },
  );

  test.each([
    ["a string", "recentRefusals"],
    ["a number", 123],
    ["an object", {}],
    ["null", null],
    ["a number entry", [123]],
    ["a null entry", [null]],
    ["an object entry", [{}]],
    ["a mixed list", [GRANTED, 123]],
    ["a blank entry", ["   "]],
    ["an empty entry", [""]],
  ])(
    "refuses %s functions with 400 instead of answering allowed:true",
    async (_name, functions) => {
      const result = await post({ agentId: "risk-analyst", functions });
      expect(result.status).toBe(400);
      expect(result.json).toEqual({
        error: "Functions must be a list of function names.",
      });
    },
  );
});
