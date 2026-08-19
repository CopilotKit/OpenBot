import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRoutes } from "../src/computer/approval-routes";
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * The surface a person answers on, exercised as the browser reaches it.
 *
 * Tested through the routes rather than through the registry alone, because the two things that go
 * wrong here are things only the handler can get wrong: which Bot an answer is recorded against, and
 * what the reply carries back out of the process. Neither is visible from the registry's own tests,
 * and both are the sort of thing a sibling handler quietly diverges on.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

const ASKING: ActionPolicy = {
  mode: "enforce",
  deny: [],
  ask: ['contains(element.name, "submit")'],
  allow: ["true"],
};

/** The person whose turn raised the question. Not the person who answers it. */
const DRIVER = { id: "dev-local-user" };

const MANAGER = {
  id: "manager-user",
  email: "manager@openbot.test",
  role: "user",
} as const;

function fakeClient() {
  const calls: string[] = [];
  const client = {
    snapshot: async () => SNAPSHOT,
    click: async () => {
      calls.push("click");
      return { action: "click", url: SNAPSHOT.url, elapsedMs: 1 } as never;
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, calls };
}

/**
 * One audit store and one registry behind both halves, which is the arrangement being tested.
 *
 * The question is raised by the gateway and answered on the routes, minutes apart and by different
 * people, and the only thing joining the two rows is the approval id. A test that gave each half its
 * own store could not see whether they agree.
 */
async function surface() {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const approvals: ApprovalRegistry = createApprovalRegistry();
  const { client, calls } = fakeClient();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => ASKING,
    approvals,
  });
  await gateway.snapshot("bot-1");

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", MANAGER);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createApprovalRoutes(approvals, auditStore, requireUser));

  /** A click that meets the ask rule, and the question it leaves open. */
  const ask = async (botId: string) =>
    (await gateway
      .click(botId, botId, DRIVER, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

  return { app, approvals, gateway, ask, rows, calls };
}

const answer =
  (app: Hono<{ Variables: AppVariables }>) =>
  async (botId: string, approvalId: string, granted: boolean) =>
    app.request(`/${botId}/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted }),
    });

describe("answering a question", () => {
  test("records the answer under the person who gave it and lets the action run", async () => {
    const { app, ask, rows, gateway, calls } = await surface();
    const asked = await ask("bot-1");

    const response = await answer(app)("bot-1", asked.approvalId, true);
    expect(response.status).toBe(200);

    await gateway.click(
      "bot-1",
      "bot-1",
      DRIVER,
      { ref: "e9", snapshotId: 7 },
      undefined,
      asked.approvalId,
    );

    expect(calls).toEqual(["click"]);
    // Three rows for one action, and each answers a different question: it was asked, somebody said
    // yes, it happened.
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "approval.granted",
      "computer.action_allowed",
    ]);
    // The answer is credited to whoever answered, not to whoever was driving the Bot, which is the
    // one thing an approval trail must never get wrong.
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
    expect(rows[1]?.payload.actor).toBe("manager-user");
    expect(rows[1]?.actorUserId).toBe("manager-user");
    expect(rows[1]?.payload.asked).toBe("dev-local-user");
    const decision = rows[2]?.payload.decision as { approvedBy?: string };
    expect(decision.approvedBy).toBe("manager-user");
  });

  test("files the answer against the Bot the question was about, not the address it arrived at", async () => {
    // The Bot in the path is whatever the caller typed. Taking it from the request would put a grant
    // in the trail under one Bot and the action it paid for under another, joined by an id that
    // appears on both and reconciles neither.
    const { app, ask, rows } = await surface();
    const asked = await ask("bot-1");

    const wrongBot = await answer(app)("bot-2", asked.approvalId, true);
    expect(wrongBot.status).toBe(409);
    expect(rows.map((row) => row.eventType)).toEqual(["approval.requested"]);

    expect((await answer(app)("bot-1", asked.approvalId, true)).status).toBe(
      200,
    );
    expect(rows[1]?.targetId).toBe("bot-1");
    expect(rows[1]?.payload.bot).toBe("bot-1");
  });

  test("never sends the binding out of the process", async () => {
    // The fingerprint is what ties an approval to one action, and it is compared here. Nothing on
    // the surface can do anything with it, and a handler that returned it would be quietly undoing
    // the invariant its sibling four lines up is careful to keep.
    const { app, ask } = await surface();
    const asked = await ask("bot-1");

    const listed = await (await app.request("/bot-1")).json();
    const answered = await (
      await answer(app)("bot-1", asked.approvalId, true)
    ).json();

    for (const record of [
      ...(listed as { approvals: Record<string, unknown>[] }).approvals,
      answered as Record<string, unknown>,
    ]) {
      expect(record.fingerprint).toBeUndefined();
      expect(record.actor).toBeUndefined();
      expect(record.target).toBeUndefined();
      expect(record.question).toContain("Submit order");
    }
  });

  test("a question nobody is waiting on any more is a conflict, not a fault", async () => {
    const { app, ask } = await surface();
    const asked = await ask("bot-1");

    expect((await answer(app)("bot-1", asked.approvalId, false)).status).toBe(
      200,
    );
    // Answered once, and not answerable again: otherwise a second tab can quietly overturn a
    // decision the trail has already recorded as made.
    expect((await answer(app)("bot-1", asked.approvalId, true)).status).toBe(
      409,
    );
    expect((await answer(app)("bot-1", "not-a-real-id", true)).status).toBe(
      409,
    );
  });

  test("refuses to read a missing answer as either one", async () => {
    const { app, ask, rows } = await surface();
    const asked = await ask("bot-1");

    const response = await app.request(`/bot-1/${asked.approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(rows).toHaveLength(1);
  });

  test("shows one Bot's open questions and not another's", async () => {
    const { app, ask } = await surface();
    const asked = await ask("bot-1");

    const mine = (await (await app.request("/bot-1")).json()) as {
      approvals: { id: string; rule: string }[];
    };
    expect(mine.approvals).toHaveLength(1);
    expect(mine.approvals[0]?.id).toBe(asked.approvalId);
    expect(mine.approvals[0]?.rule).toBe('contains(element.name, "submit")');

    const theirs = (await (await app.request("/bot-2")).json()) as {
      approvals: unknown[];
    };
    expect(theirs.approvals).toEqual([]);
  });

  test("a declined answer stops the action without pretending it was refused by a rule", async () => {
    const { app, ask, rows, gateway, calls } = await surface();
    const asked = await ask("bot-1");

    await answer(app)("bot-1", asked.approvalId, false);
    // Presenting a No asks again rather than going through, and nothing reached the computer.
    await expect(
      gateway.click(
        "bot-1",
        "bot-1",
        DRIVER,
        { ref: "e9", snapshotId: 7 },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "approval.denied",
      "approval.requested",
    ]);
  });

  test("an answer is spendable only on the action it was given for", async () => {
    const { app, ask, approvals } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true);

    const elsewhere = approvals.consume(
      asked.approvalId,
      fingerprintOf({
        botId: "bot-1",
        toolName: "computer_click",
        ref: "e1",
        pageUrl: SNAPSHOT.url,
      }),
    );
    expect(elsewhere.ok).toBe(false);
  });
});
