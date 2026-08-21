import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

describe("computer routes", () => {
  test("gets a screenshot through the governed computer gateway", async () => {
    const requestedBotIds: string[] = [];
    const gateway = {
      screenshot: async (botId: string) => {
        requestedBotIds.push(botId);
        return { image: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as ComputerGateway;
    const policyStore = {} as PolicyStore;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      _context,
      next,
    ) => next();
    // Permissive: what this covers is the gateway seam, not who may act as the Bot. That question
    // has its own suite in bot-access.test.ts.
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      requireUser,
      async () => true,
    );

    const response = await routes.request(
      "http://openbot.test/bot-17/screenshot",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(requestedBotIds).toEqual(["bot-17"]);
  });
});
