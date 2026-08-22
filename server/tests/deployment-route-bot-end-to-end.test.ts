import { afterEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * A Bot named after a deployment route, over a real socket.
 *
 * The router's guard steps aside for `/policy` and `/fleet`, which are its own paths and not about a
 * Bot. The question this answers is what a request UNDER one of those names reaches, and only a
 * listener can say: a test that reads the URL it passed to a stubbed fetch is describing its own
 * argument, while the thing being prevented is a request arriving at a computer that nobody was
 * asked about. So this drives the real router through the real gateway and the real transport, and
 * asks the far side what it got.
 *
 * The reserved-id checks in `tenant-package.ts` mean no such Bot can be declared or survive a start,
 * which is the fix. This is the layer underneath it: if a Bot with that id ever did exist, the guard
 * still has to be the thing that answers.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const TOKEN = "computer-token-for-this-test";

function serveComputer() {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push(new URL(request.url).pathname);
      return Response.json({ ok: true, state: "ready" });
    },
  });
  servers.push(server);
  return { received, baseUrl: `http://127.0.0.1:${server.port}` };
}

/** Answers for one Bot only, the way the store's access filter does. */
function appFor(baseUrl: string, permitted: string) {
  const asked: string[] = [];
  const rows: AuditEventInput[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => baseUrl,
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    auditStore: {
      insert: async (event: AuditEventInput) => {
        rows.push(event);
      },
    } as unknown as AuditStore,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    token: TOKEN,
  });
  const actor: AuthenticatedActor = {
    id: "somebody",
    email: "somebody@openbot.test",
    role: "user",
  };
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  return {
    asked,
    app: createComputerRoutes(
      gateway,
      {} as PolicyStore,
      asActor,
      async (_who, botId) => {
        asked.push(botId);
        return botId === permitted;
      },
    ),
  };
}

describe("a Bot named after a deployment route, end to end", () => {
  test("a permitted Bot's read reaches the computer", async () => {
    // The control. Everything below asserts that nothing arrived, which proves nothing unless a
    // request that should arrive does.
    const { received, baseUrl } = serveComputer();
    const { app, asked } = appFor(baseUrl, "bot-1");

    const response = await app.request("http://openbot.test/bot-1/read");

    expect(response.status).toBe(200);
    expect(received).toEqual(["/read"]);
    expect(asked).toEqual(["bot-1"]);
  });

  for (const name of ["policy", "fleet"]) {
    test(`nothing under "${name}" reaches the computer without the guard answering`, async () => {
      const { received, baseUrl } = serveComputer();
      // `name` is the permitted Bot, so a request that gets past the guard would be forwarded and
      // arrive. Nothing arriving therefore means the guard, not the gateway, ended the request.
      const { app, asked } = appFor(baseUrl, "never-this-bot");

      const response = await app.request(`http://openbot.test/${name}/read`);

      expect(response.status).toBe(404);
      expect(received).toEqual([]);
      expect(asked).toEqual([name]);
    });
  }

  test("a Bot called policy is served the moment the guard permits it, and not before", async () => {
    // The other direction, so the refusal above is shown to be the guard's answer rather than a
    // route that cannot be reached at all.
    const { received, baseUrl } = serveComputer();
    const { app, asked } = appFor(baseUrl, "policy");

    const response = await app.request("http://openbot.test/policy/read");

    expect(response.status).toBe(200);
    expect(received).toEqual(["/read"]);
    expect(asked).toEqual(["policy"]);
  });
});
