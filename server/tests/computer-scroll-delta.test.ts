import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

function appWith(calls: { deltaY?: number }[]) {
  const gateway = {
    scroll: async (
      _botId: string,
      _actor: unknown,
      input: { deltaY?: number },
    ) => {
      calls.push({
        ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
      });
      return { action: "scroll", url: "https://openbot.test/" };
    },
    humanInput: async (_botId: string, input: { deltaY?: number }) => {
      calls.push({
        ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
      });
      return { action: "human_scroll", url: "https://openbot.test/" };
    },
  } as unknown as ComputerGateway;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "user@openbot.test",
      role: "admin",
    });
    await next();
  };
  return createComputerRoutes(
    gateway,
    {} as PolicyStore,
    requireUser,
    async () => true,
  );
}

/**
 * The body is sent as text, not as a stringified object.
 *
 * `JSON.stringify({ deltaY: Infinity })` is `{"deltaY":null}`, so an object literal cannot express
 * what a client actually puts on the wire. `1e999` is valid JSON and parses to `Infinity`, which is
 * the value this endpoint has to answer for.
 */
async function postScroll(
  app: ReturnType<typeof createComputerRoutes>,
  path: string,
  body: string,
) {
  return app.request(`http://openbot.test/bot-1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe.each(["/scroll", "/human/scroll"])("POST %s deltaY", (path) => {
  test("a valid delta reaches the gateway", async () => {
    const calls: { deltaY?: number }[] = [];
    const response = await postScroll(appWith(calls), path, '{"deltaY":400}');

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ deltaY: 400 }]);
  });

  test("an absent delta still scrolls the computer's own default", async () => {
    const calls: { deltaY?: number }[] = [];
    const response = await postScroll(appWith(calls), path, "{}");

    expect(response.status).toBe(200);
    expect(calls).toEqual([{}]);
  });

  test.each([
    ["Infinity", "1e999"],
    ["negative Infinity", "-1e999"],
    ["a string", '"400"'],
    ["null", "null"],
    ["a boolean", "true"],
  ])(
    "rejects %s with 400 and never reaches the gateway",
    async (_name, raw) => {
      const calls: { deltaY?: number }[] = [];
      const response = await postScroll(
        appWith(calls),
        path,
        `{"deltaY":${raw}}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "deltaY must be a finite number of pixels.",
      });
      expect(calls).toEqual([]);
    },
  );
});
