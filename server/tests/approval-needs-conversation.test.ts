import { afterEach, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { approvalAction } from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * A look at a page that a rule asks about, sent without its conversation.
 *
 * The browser sends a navigation straight to the computer; only changes travel with the conversation
 * the approval card is drawn in. With a rule like "ask before opening pages", the gate wanted to ask
 * and had nowhere to, so the route answered a bare 500 with the refusal text, and the Bot told the
 * person "this browser action requires an approval flow that isn't available in this chat". The route
 * now says what the browser has to do, so it can send the same call again with the conversation.
 *
 * The gate here asks the way the approval service does, through `approvalAction`, and the computer is
 * a real listener so the test can show nothing reached it.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("a navigation a rule asks about comes back as needing its conversation, not done", async () => {
  let computerCalls = 0;
  const computer = Bun.serve({
    port: 0,
    fetch: async () => {
      computerCalls++;
      return Response.json({ url: "https://example.com/", title: "Example" });
    },
  });
  servers.push(computer);
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-person",
    locate: async () => `http://127.0.0.1:${computer.port}`,
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    auditStore: {
      insert: async (_event: AuditEventInput) => undefined,
    } as unknown as AuditStore,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    token: "computer-token-for-this-test",
    // A rule that asks: the approval service turns the candidate into an action to wait on.
    approvalGate: async (candidate) => {
      approvalAction(candidate);
      return undefined;
    },
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
  const app = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asActor,
    async () => true,
  );

  const response = await app.request("http://openbot.test/bot-1/navigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/" }),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    needsConversation: true,
    notPerformed: true,
  });
  expect(computerCalls).toBe(0);
});
