import { afterEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createComputerGateway,
  mintControlLease,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The whole path a person's input takes, over a real socket.
 *
 * The unit tests either side of this one stub the fetch, which means the URL they assert on is a
 * string this process built rather than a request anything received. The thing being prevented here
 * is a request ARRIVING somewhere it should not, and only a listener can say where one arrived: the
 * `..` in `/human/../exec` is resolved by URL parsing inside fetch, so a test that reads the string
 * it passed in is describing its own argument. This one starts a server, drives the real router
 * through the real gateway and the real transport, and asks the server what it got.
 *
 * It stands in for `agent-computer` rather than running it, because that process opens Chromium at
 * import time. What it reproduces is the part that matters: an HTTP API on the other end of the
 * transport, with endpoints beyond the four this route is allowed to reach.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const TOKEN = "computer-token-for-this-test";
const CONTROL_LEASE = mintControlLease("user-1");

/** What the far side actually received, in the order it arrived. */
type Received = { path: string; token: string | null; body: unknown };

function serveComputer() {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        token: request.headers.get("x-openbot-computer-token"),
        body: await request.json().catch(() => null),
      });
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { received, baseUrl: `http://127.0.0.1:${server.port}` };
}

function appFor(baseUrl: string) {
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
  // No fetchImpl: the transport uses the platform's own, which is what resolves the path.
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
    id: "user-1",
    email: "member@openbot.test",
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
    rows,
    app: createComputerRoutes(
      gateway,
      {} as PolicyStore,
      asActor,
      async () => true,
    ),
  };
}

async function drive(kind: string, body: unknown) {
  const { received, baseUrl } = serveComputer();
  const { app, rows } = appFor(baseUrl);
  const response = await app.request(
    `http://openbot.test/bot-1/human/${kind}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(body && typeof body === "object" ? body : {}),
        lease: CONTROL_LEASE,
      }),
    },
  );
  return { response, received, rows };
}

describe("a person's input, end to end", () => {
  test("a click arrives at the click endpoint, carrying the computer token", async () => {
    const { response, received } = await drive("click", { x: 10, y: 20 });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/human/click");
    expect(received[0]?.token).toBe(TOKEN);
    expect(received[0]?.body).toEqual({
      x: 10,
      y: 20,
      lease: CONTROL_LEASE,
    });
  });

  test("refuses input without the private lease before it reaches the computer", async () => {
    const { received, baseUrl } = serveComputer();
    const { app } = appFor(baseUrl);
    const response = await app.request(
      "http://openbot.test/bot-1/human/click",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 10, y: 20 }),
      },
    );

    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });

  test("refuses a lease minted for another signed-in actor", async () => {
    const { received, baseUrl } = serveComputer();
    const { app } = appFor(baseUrl);
    const response = await app.request(
      "http://openbot.test/bot-1/human/click",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x: 10,
          y: 20,
          lease: mintControlLease("another-user"),
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(received).toEqual([]);
  });

  test.each([
    [
      "../computers/reset",
      "/computers/reset",
      "wipes the profile and every login in it",
    ],
    ["../exec", "/exec", "runs a command on the computer"],
    ["../../health", "/health", "leaves the Bot's own surface entirely"],
  ])(
    "a body asking for %s does not arrive at %s, which %s",
    async (kind, forbidden) => {
      const { received } = await drive("click", {
        kind,
        command: "cat /workspace/notes",
        x: 1,
        y: 1,
      });

      // The assertion is about what the far side was asked to do, not about what this process
      // intended: every path below is one the transport would have reached with the deployment's
      // token attached, and none of them is guarded by the takeover check that protects `/human/*`.
      expect(received.map((request) => request.path)).not.toContain(forbidden);
    },
  );

  test("the four gestures still reach their own endpoints", async () => {
    for (const kind of ["click", "type", "key", "scroll"]) {
      const { received } = await drive(kind, { x: 1, y: 1, text: "hello" });

      expect(received.map((request) => request.path)).toEqual([
        `/human/${kind}`,
      ]);
    }
  });
});
