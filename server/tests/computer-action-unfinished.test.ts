import { afterEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { unfinishedFromLog } from "../../agent-computer/src/action-failure";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  ActionUnfinishedError,
  createComputerTransport,
  ElementNotFoundError,
  StaleSnapshotError,
} from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * What a Bot is told when it clicks a button that is on the page and the click cannot finish.
 *
 * Found on Windows: a sign-up page whose own security policy (`form-action 'none'`) refused to send
 * its form. Every Sign up click timed out waiting for a navigation that never began, and the server
 * read each timeout as an element that had gone: "Element f1e13 is not on the page any more. Take a
 * fresh snapshot". The fresh snapshot gave the same ref, and the Bot looped nine times.
 *
 * The computer now says why (agent-computer/src/action-failure.ts). These drive its answer through
 * the real routes over a socket, so the reason survives being thrown here and serialised again.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** Playwright 1.62's call log for a click on a button whose form never navigated. */
const CLICK_WAITING = [
  "click: Timeout 10000ms exceeded.",
  "Call log:",
  "  - waiting for locator('aria-ref=f1e13')",
  `    - locator resolved to <button type="submit">Sign up</button>`,
  "  - attempting click action",
  "    - waiting for element to be visible, enabled and stable",
  "    - element is visible, enabled and stable",
  "    - scrolling into view if needed",
  "    - done scrolling",
  "    - performing click action",
  "    - click action done",
  "    - waiting for scheduled navigations to finish",
  "",
].join("\n");

/** Chromium's console line for the refusal, as the computer captures it during the click. */
const CSP_REFUSAL = `Sending form data to 'https://inbox.example/f26c5bd6' violates the following Content Security Policy directive: "form-action 'none'". The request has been blocked.\n`;

/** The computer, answering exactly as `agent-computer/src/index.ts` does for this click. */
function computerAnswering(body: unknown, status: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => Response.json(body, { status }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function refused() {
  const unfinished = unfinishedFromLog(CLICK_WAITING, [CSP_REFUSAL]);
  if (!unfinished) throw new Error("The refusal was not recognised.");
  return { error: unfinished.message, unfinished: unfinished.reason };
}

async function click(baseUrl: string) {
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-person",
    locate: async () => baseUrl,
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
  const response = await app.request("http://openbot.test/bot-1/click", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "f1e13", snapshotId: 1 }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("a click on a button that is there, whose form the page refused to send", () => {
  test("reaches the caller as a refusal, not as stale refs or a missing element", async () => {
    const { status, body } = await click(computerAnswering(refused(), 409));

    expect(status).toBe(409);
    expect(body.unfinished).toBe("refused");
    expect(body.stale).toBeUndefined();
    expect(String(body.error)).toContain("refused to send the form");
    expect(String(body.error)).not.toContain("not on the page");
    expect(String(body.error)).not.toContain("fresh snapshot");
  });

  test("is its own condition in the client, with the computer's words", async () => {
    const transport = createComputerTransport({});
    const answer = refused();
    const thrown = await transport
      .post(computerAnswering(answer, 409), "bot-1", "/click", {
        ref: "f1e13",
        snapshotId: 1,
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ActionUnfinishedError);
    expect(thrown).not.toBeInstanceOf(StaleSnapshotError);
    expect(thrown).not.toBeInstanceOf(ElementNotFoundError);
    expect((thrown as ActionUnfinishedError).unfinished).toBe("refused");
    expect((thrown as Error).message).toBe(answer.error);
  });

  test("a stale ref is still a stale ref", async () => {
    // The half that must not move: a 409 without the reason keeps telling a Bot to re-snapshot.
    const { status, body } = await click(
      computerAnswering(
        {
          error: "Nothing on this page has the ref f1e13.",
          stale: true,
        },
        409,
      ),
    );

    expect(status).toBe(409);
    expect(body.stale).toBe(true);
    expect(body.unfinished).toBeUndefined();
  });
});
