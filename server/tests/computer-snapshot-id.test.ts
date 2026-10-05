import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

function appWith(calls: unknown[]) {
  const gateway = {
    click: async (_botId: string, _actor: unknown, ref: unknown) => {
      calls.push(ref);
      return { action: "click", url: "https://openbot.test/" };
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
 * A snapshot id is an integer the store handed out, not any number.
 *
 * `typeof 1.5 === "number"` and `1e999` parses to `Infinity`, so both used to pass the edge
 * check and then never equal the stored integer. The gateway answered a stale snapshot (409)
 * and the caller retried a request that was malformed. Malformed input is a 400 here.
 */
async function postClick(
  app: ReturnType<typeof createComputerRoutes>,
  body: string,
) {
  return app.request("http://openbot.test/bot-1/click", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /:botId/click snapshotId", () => {
  test("an integer snapshotId reaches the gateway", async () => {
    const calls: unknown[] = [];
    const response = await postClick(
      appWith(calls),
      '{"ref":"e5","snapshotId":12}',
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ ref: "e5", snapshotId: 12 }]);
  });

  test.each([
    ["a float", "1.5"],
    ["Infinity", "1e999"],
    ["negative Infinity", "-1e999"],
    ["a string", '"12"'],
    ["null", "null"],
    ["a boolean", "true"],
  ])("rejects %s with 400 and never reaches the gateway", async (_n, raw) => {
    const calls: unknown[] = [];
    const response = await postClick(
      appWith(calls),
      `{"ref":"e5","snapshotId":${raw}}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "A ref and the snapshotId it came from are both required. Take a snapshot first.",
    });
    expect(calls).toEqual([]);
  });
});
