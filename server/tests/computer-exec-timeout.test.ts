import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

function appWith(calls: { timeoutMs?: number }[]) {
  const gateway = {
    runCommand: async (
      _botId: string,
      _actor: unknown,
      input: { command: string; timeoutMs?: number },
    ) => {
      calls.push({
        ...(input.timeoutMs !== undefined
          ? { timeoutMs: input.timeoutMs }
          : {}),
      });
      return { output: "hi", timedOut: false, elapsedMs: 1 };
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

async function postExec(
  app: ReturnType<typeof createComputerRoutes>,
  body: unknown,
) {
  return app.request("http://openbot.test/bot-1/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /:botId/exec timeoutMs", () => {
  test("a valid timeout reaches the gateway", async () => {
    const calls: { timeoutMs?: number }[] = [];
    const response = await postExec(appWith(calls), {
      command: "echo hi",
      timeoutMs: 5000,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ timeoutMs: 5000 }]);
  });

  test("an absent timeout still runs with the computer default", async () => {
    const calls: { timeoutMs?: number }[] = [];
    const response = await postExec(appWith(calls), { command: "echo hi" });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{}]);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative", -1],
    ["zero", 0],
    ["below the shell floor", 999],
    ["above the shell ceiling", 600_001],
    ["a ten-hour value", 36_000_000],
    ["a fraction", 1500.5],
    ["a string", "3000"],
    ["null", null],
  ])(
    "rejects %s with 400 and never reaches the gateway",
    async (_name, timeoutMs) => {
      const calls: { timeoutMs?: number }[] = [];
      const response = await postExec(appWith(calls), {
        command: "echo hi",
        timeoutMs,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error:
          "timeoutMs must be a whole number of milliseconds between 1000 and 600000.",
      });
      expect(calls).toEqual([]);
    },
  );
});
