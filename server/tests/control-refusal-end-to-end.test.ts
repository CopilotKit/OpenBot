import { afterEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * What a Bot is told when a person has taken the wheel, over a real socket.
 *
 * The computer answers a refused action with `409 { error, humanHasControl: true }`, and the surface
 * reads that flag to decide what the model hears next: with it, a person has control; without it,
 * `staleRefs`, which renders as "your refs are stale, the page changed, call this again with the new
 * ones". So a flag lost in the middle is not a cosmetic loss. It sends a Bot back round the same
 * action against somebody who deliberately took the browser, which is the one moment it should stop.
 *
 * Driven over a socket rather than a stubbed fetch because the property is that a field survives
 * being serialised, thrown as an error, and re-serialised by the route. A stub proves the shape this
 * process built; only a listener proves what the far side actually sent and what the caller finally
 * reads.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** The computer, refusing exactly the way `agent-computer/src/index.ts` does. */
function computerAnswering(body: unknown, status: number) {
  const server = Bun.serve({
    port: 0,
    fetch: async () => Response.json(body, { status }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function routesFor(baseUrl: string) {
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
    token: "computer-token-for-this-test",
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

async function navigate(baseUrl: string) {
  const { app } = routesFor(baseUrl);
  const response = await app.request("http://openbot.test/bot-1/navigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/" }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function click(baseUrl: string) {
  const { app, rows } = routesFor(baseUrl);
  const response = await app.request("http://openbot.test/bot-1/click", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "e1", snapshotId: 1 }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    rows,
  };
}

describe("a refusal because a person has the wheel", () => {
  test("reaches the caller as one, not as stale refs", async () => {
    const { status, body } = await click(
      computerAnswering(
        {
          error: "A person has taken control of this computer.",
          humanHasControl: true,
        },
        409,
      ),
    );

    expect(status).toBe(409);
    expect(body.humanHasControl).toBe(true);
    expect(body.error).toBe("A person has taken control of this computer.");
  });

  test("a stale snapshot is still a stale snapshot", async () => {
    // The half that must not move. Without this, marking every 409 as a takeover would pass the test
    // above while telling a Bot with genuinely stale refs to go and wait for a person who is not there.
    const { status, body } = await click(
      computerAnswering({ error: "Snapshot 3 is not the current one." }, 409),
    );

    expect(status).toBe(409);
    expect(body.humanHasControl).toBeUndefined();
    expect(body.error).toBe("Snapshot 3 is not the current one.");
  });

  test("reaches the caller from navigate too, which is the other place the computer refuses", async () => {
    // The computer marks the takeover on its action path and on navigate (agent-computer/src/index.ts
    // 938 and 721). Navigate does not go through the shared acting helper, so carrying the flag in
    // that helper alone would fix one of the two and leave the other telling a Bot to re-snapshot.
    const { status, body } = await navigate(
      computerAnswering(
        {
          error: "A person has taken control of this computer.",
          humanHasControl: true,
        },
        409,
      ),
    );

    expect(status).toBe(409);
    expect(body.humanHasControl).toBe(true);
  });

  test("the refusal is still audited as a refusal", async () => {
    // The gateway writes a row when a forwarded action fails. Telling the caller something new must
    // not quietly cost the trail the record that the action did not happen.
    const { rows } = await click(
      computerAnswering(
        {
          error: "A person has taken control of this computer.",
          humanHasControl: true,
        },
        409,
      ),
    );

    expect(rows.length).toBeGreaterThan(0);
  });
});
