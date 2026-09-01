import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  type ComputerGateway,
  mintControlLease,
} from "../src/computer/gateway";
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

/**
 * The fleet listing is the one route here that is not about the Bot in its path.
 *
 * `:botId` is ignored and the handler returns every computer, so a signed-in person asking about a
 * Bot they own learned every Bot id in the deployment and whether its computer was running,
 * private coworkers included. Being signed in is not the question; administering the deployment is.
 */
const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const administrator: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function appFor(actor: AuthenticatedActor, computers: () => Promise<unknown>) {
  let listed = 0;
  const countingGateway = {
    async computers() {
      listed += 1;
      return computers();
    },
  } as ComputerGateway;

  return {
    app: createComputerRoutes(
      countingGateway,
      {} as PolicyStore,
      asActor(actor),
      // Permissive. Whether this person may act as the Bot in the path is a different question with
      // its own suite, and `:botId` is not what this route answers about anyway.
      async () => true,
    ),
    listed: () => listed,
  };
}

describe("computer fleet listing", () => {
  test("refuses a signed-in user the fleet, and does not ask the gateway", async () => {
    const { app, listed } = appFor(member, async () => ({
      isolation: "per-bot",
      computers: [
        { botId: "private-coworker", running: true, startedAt: null },
      ],
    }));

    const response = await app.request("http://openbot.test/any-bot/computers");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
    // Refused before the gateway is asked: a check that runs after the fleet has been read is not a
    // check, it is a filter on the response.
    expect(listed()).toBe(0);
  });

  test("lets an administrator see the fleet", async () => {
    const fleet = {
      isolation: "per-bot" as const,
      computers: [
        {
          botId: "private-coworker",
          running: true,
          startedAt: "2026-08-20T00:00:00.000Z",
          egress: null,
        },
      ],
    };
    const { app, listed } = appFor(administrator, async () => fleet);

    const response = await app.request("http://openbot.test/any-bot/computers");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(fleet);
    expect(listed()).toBe(1);
  });
});

/**
 * The kind of human input is what the path says, and only what the path says.
 *
 * The route checks `:kind` against the four gestures a person's mouse and keyboard produce, and then
 * built the call as `{ kind, ...body }`, so a body carrying its own `kind` replaced the value that
 * had just been checked. The gateway puts that value straight into the path it calls on the
 * computer, so the check decided one thing and the request went somewhere else.
 *
 * This route is the one that deliberately skips the policy decision and the audit row, because a
 * takeover exists so a person can type the thing nothing should keep. That makes it the worst one to
 * be able to redirect: nothing downstream writes the row that would have shown where it went.
 */
describe("human input", () => {
  function recordingGateway() {
    const calls: Array<{ botId: string; input: Record<string, unknown> }> = [];
    const gateway = {
      humanInput: async (
        botId: string,
        _actor: unknown,
        input: Record<string, unknown>,
      ) => {
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

  async function send(body: unknown, kind = "click") {
    const { app, calls } = recordingGateway();
    const response = await app.request(
      `http://openbot.test/bot-1/human/${kind}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(body && typeof body === "object" ? body : {}),
          lease: mintControlLease(member.id),
        }),
      },
    );
    return { response, calls };
  }

  test("carries a real gesture through with its coordinates", async () => {
    const { response, calls } = await send({ x: 10, y: 20 });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.kind).toBe("click");
    expect(calls[0]?.input.x).toBe(10);
  });

  test("a body naming its own kind does not decide where the call goes", async () => {
    // `../computers/reset` is the shape that matters: the gateway interpolates this into the path it
    // calls, and a fetch resolves the `..` away, so the request lands on a different endpoint of the
    // computer's API carrying the deployment's computer token.
    const { calls } = await send({ kind: "../computers/reset", x: 1, y: 1 });

    expect(calls[0]?.input.kind).toBe("click");
  });

  test("a body naming its own kind cannot reach the shell either", async () => {
    const { calls } = await send(
      { kind: "../exec", command: "cat /workspace/notes" },
      "type",
    );

    expect(calls[0]?.input.kind).toBe("type");
  }, 10_000);

  test("a kind the path does not allow is still refused", async () => {
    // The existing check, which must go on working: the four gestures are the whole surface.
    const { response, calls } = await send({ x: 1 }, "screenshot");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
