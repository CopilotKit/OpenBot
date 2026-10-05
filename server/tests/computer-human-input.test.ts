import { describe, expect, test } from "bun:test";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type { AppVariables } from "../src/auth/guards";
import type { MiddlewareHandler } from "hono";

/**
 * A person's own mouse and keyboard, shaped before it travels.
 *
 * Only scroll was checked on this route. A click with `{"x": "ten"}`, a type with
 * `{"text": 123}` or a key with `{}` travelled to the computer untouched, and the failure
 * surfaced as whatever the computer returned for garbage — a 500 here, or a 200 no-op.
 * The shapes below are the ones the gateway's `HumanInput` type already promises: `click`
 * carries viewport-pixel coordinates, `type` carries text, `key` carries a key name.
 */

const member = {
  id: "u1",
  email: "member@openbot.test",
  role: "user",
} as const;

function asActor(
  actor: typeof member,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { ...actor });
    await next();
  };
}

function recordingGateway() {
  const calls: Array<{ botId: string; input: Record<string, unknown> }> = [];
  const gateway = {
    humanInput: async (botId: string, input: Record<string, unknown>) => {
      calls.push({ botId, input });
      return { ok: true };
    },
  } as unknown as ComputerGateway;
  return {
    calls,
    app: createComputerRoutes(
      gateway,
      {} as PolicyStore,
      asActor(member),
      async () => true,
    ),
  };
}

async function send(body: unknown, kind: string) {
  const { app, calls } = recordingGateway();
  const response = await app.request(
    `http://openbot.test/bot-1/human/${kind}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { response, calls };
}

describe("human input payloads", () => {
  test("a click with coordinates still reaches the computer", async () => {
    const { response, calls } = await send({ x: 10, y: 20 }, "click");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({ kind: "click", x: 10, y: 20 });
  });

  test("a type with text still reaches the computer", async () => {
    const { response, calls } = await send({ text: "hello" }, "type");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("a key with a name still reaches the computer", async () => {
    const { response, calls } = await send({ key: "Enter" }, "key");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["a string x", { x: "ten", y: 20 }],
    ["a missing x", { y: 20 }],
    ["a missing y", { x: 10 }],
    ["NaN x", { x: Number.NaN, y: 20 }],
    ["Infinity y", { x: 10, y: Number.POSITIVE_INFINITY }],
    ["null", null],
    ["an empty body", {}],
  ])("refuses a click with %s and never forwards it", async (_name, body) => {
    const { response, calls } = await send(body, "click");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A click needs numeric x and y coordinates.",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["a number", { text: 123 }],
    ["null", { text: null }],
    ["an object", { text: {} }],
    ["a missing text", {}],
  ])("refuses a type with %s and never forwards it", async (_name, body) => {
    const { response, calls } = await send(body, "type");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The text to enter is required.",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["a number", { key: 123 }],
    ["an empty name", { key: "" }],
    ["a missing key", {}],
    ["null", null],
  ])("refuses a key with %s and never forwards it", async (_name, body) => {
    const { response, calls } = await send(body, "key");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A key name is required, such as Enter or Tab.",
    });
    expect(calls).toHaveLength(0);
  });

  test("a scroll without a delta still travels, as before", async () => {
    const { response, calls } = await send({}, "scroll");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
