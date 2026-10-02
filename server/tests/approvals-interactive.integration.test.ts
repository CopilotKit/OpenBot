import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import {
  ALREADY_WAITING,
  createApprovalService,
  DECLINED_BY_PERSON,
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalAction,
  type ApprovalContinuation,
  parseApprovalContinuation,
} from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The interactive path, over HTTP: a person's own chat asks the browser to click, the browser posts
 * the AG-UI call identity to `/api/approvals/computer/:botId`, and the server's gate holds it for the
 * person. Real store and gateway; the computer is a local fetch seam that counts what reached it.
 * The production `frontend` also checks the call against the saved Intelligence thread, which is a
 * seam here.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `interactive-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const store = createApprovalStore(database);
const clicks: unknown[] = [];

const gateway = createComputerGateway({
  provider: {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://computer:4100",
    status: async (id) => ({ botId: id, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
  },
  auditStore: { insert: async () => undefined },
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: (candidate) => service.gate(candidate),
  fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path !== "/click" && path !== "/type")
      throw new Error(`Unexpected ${path}`);
    clicks.push(JSON.parse(String(init?.body)));
    return Response.json({
      action: "click",
      url: "https://httpbin.org/forms/post",
      elapsedMs: 1,
    });
  },
});
const run = (snapshot: ApprovalContinuation, actorId: string, bot = botId) => {
  const tool = createHeadlessComputerTools({
    gateway,
    botId: bot,
    actor: { id: actorId, userId: actorId, initiator: { kind: "person" } },
  }).find((candidate) => candidate.definition.name === snapshot.toolName);
  if (!tool) throw new Error("no tool");
  return tool.execute(snapshot.args, {
    toolCallId: snapshot.toolCallId,
    signal: new AbortController().signal,
  });
};
const service = createApprovalService(store, undefined, (actorId, bot, snap) =>
  run(snap, actorId, bot),
);
const execute = (action: ApprovalAction) =>
  run(
    parseApprovalContinuation(action.continuation),
    action.actorId,
    action.botId,
  );

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/approvals",
  createApprovalRoutes(service, async (context, next) => {
    const id = context.req.header("x-test-user") ?? "";
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  }),
);
const call = (user: string, path: string, body?: unknown, method = "POST") =>
  app.request(`/api/approvals${path}`, {
    method: body === undefined && method === "POST" ? "GET" : method,
    headers: { "x-test-user": user, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function snapshot(
  options: {
    threadId?: string;
    args?: Record<string, unknown>;
    toolName?: string;
    saidAgain?: boolean;
  } = {},
): ApprovalContinuation {
  const toolCallId = randomUUID();
  const toolName = options.toolName ?? "computer_click";
  const args = options.args ?? { ref: "e7", snapshotId: 3 };
  return {
    runId: randomUUID(),
    // A conversation of its own unless the test names one, so tests do not see each other's answers.
    threadId: options.threadId ?? `${prefix}-thread-${randomUUID()}`,
    toolCallId,
    toolName,
    args,
    messages: [
      { id: "u1", role: "user", content: "Fill in and submit the pizza form" },
      ...(options.saidAgain
        ? [
            {
              id: "u2",
              role: "user" as const,
              content: "Yes, click it after all",
            },
          ]
        : []),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          },
        ],
      },
    ],
    state: {},
    context: [],
    forwardedProps: {},
  };
}
const resume = async (id: string) => {
  const continued: { content: string; error?: string }[] = [];
  await service.resume(owner, id, {
    validate: (action) =>
      service.validateReentry(action, () => execute(action)),
    execute,
    continue: async ({ result }) => {
      continued.push(result);
    },
  });
  return continued;
};

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
  await store.setEnabled(owner, true);
});
afterAll(async () => {
  const ids = (await store.list(owner)).map((request) => request.id);
  if (ids.length)
    await database
      .delete(workItems)
      .where(
        and(eq(workItems.kind, "approval.resume"), inArray(workItems.key, ids)),
      );
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("a click from a person's own chat waits, runs once on allow once, and is never repeated", async () => {
  clicks.length = 0;
  const click = snapshot();
  const pending = await call(owner, `/computer/${botId}`, click);
  expect(pending.status).toBe(202);
  const { approvalId } = (await pending.json()) as { approvalId: string };
  expect(clicks).toEqual([]);

  // Another person can neither read nor decide it.
  const theirs = (await (await call(stranger, "")).json()) as {
    requests: unknown[];
  };
  expect(theirs.requests).toEqual([]);
  expect(
    (
      await call(stranger, `/${approvalId}/decision`, {
        decision: "allow_once",
      })
    ).status,
  ).toBe(404);

  // The owner sees it, with the call id the chat draws it under.
  const mine = (await (await call(owner, "")).json()) as {
    requests: { id: string; status: string; action: { toolCallId?: string } }[];
  };
  expect(mine.requests).toContainEqual(
    expect.objectContaining({
      id: approvalId,
      status: "pending",
      action: expect.objectContaining({ toolCallId: click.toolCallId }),
    }),
  );

  expect(
    (await call(owner, `/${approvalId}/decision`, { decision: "allow_once" }))
      .status,
  ).toBe(200);
  const continued = await resume(approvalId);
  expect(clicks).toHaveLength(1);
  expect(continued).toHaveLength(1);
  expect(continued[0]?.error).toBeUndefined();

  // The same call posted again replays the stored result; the computer is not touched again.
  const replay = await call(owner, `/computer/${botId}`, click);
  expect(replay.status).toBe(200);
  expect(clicks).toHaveLength(1);
  // Resuming again is a no-op, and a second decision is refused.
  await resume(approvalId);
  expect(clicks).toHaveLength(1);
  expect(
    (await call(owner, `/${approvalId}/decision`, { decision: "allow_once" }))
      .status,
  ).toBe(400);
});

test("deny blocks the click and tells the conversation", async () => {
  clicks.length = 0;
  const pending = await call(owner, `/computer/${botId}`, snapshot());
  const { approvalId } = (await pending.json()) as { approvalId: string };
  await call(owner, `/${approvalId}/decision`, { decision: "deny" });
  const continued = await resume(approvalId);
  expect(clicks).toEqual([]);
  // Plainly the person's decision, not a policy, and an instruction not to go round it.
  expect(continued).toEqual([
    { content: DECLINED_BY_PERSON, error: DECLINED_BY_PERSON },
  ]);
  expect(DECLINED_BY_PERSON).toContain("not a policy or a boundary");
});

test("always allow runs this one and saves a rule, so the next click in this place does not ask", async () => {
  clicks.length = 0;
  const pending = await call(owner, `/computer/${botId}`, snapshot());
  const { approvalId } = (await pending.json()) as { approvalId: string };
  await call(owner, `/${approvalId}/decision`, { decision: "allow_always" });
  await resume(approvalId);
  expect(clicks).toHaveLength(1);
  const next = await call(owner, `/computer/${botId}`, snapshot());
  expect(next.status).toBe(200);
  expect(clicks).toHaveLength(2);
});

test("a click whose identity is not an unanswered call in the conversation is refused", async () => {
  clicks.length = 0;
  const forged = { ...snapshot(), toolCallId: "not-in-messages" };
  const response = await call(owner, `/computer/${botId}`, forged);
  expect(response.status).toBe(400);
  expect(clicks).toEqual([]);
});

const pendingFor = async (threadId: string) =>
  (await store.list(owner)).filter(
    (request) =>
      request.action.threadId === threadId && request.status === "pending",
  );

test("after a deny the Bot cannot try the same or an equivalent click again until the person speaks", async () => {
  clicks.length = 0;
  const bot = `${prefix}-bot-${randomUUID()}`;
  const threadId = `${prefix}-declined-${randomUUID()}`;
  const first = await call(owner, `/computer/${bot}`, snapshot({ threadId }));
  const { approvalId } = (await first.json()) as { approvalId: string };
  await call(owner, `/${approvalId}/decision`, { decision: "deny" });
  await resume(approvalId);
  // A retry on a fresh page read: new call id and snapshot id, the same action.
  const retry = await call(
    owner,
    `/computer/${bot}`,
    snapshot({ threadId, args: { ref: "e9", snapshotId: 4 } }),
  );
  expect(retry.status).toBe(400);
  expect(((await retry.json()) as { error: string }).error).toBe(
    DECLINED_BY_PERSON,
  );
  expect(await pendingFor(threadId)).toEqual([]);
  // Switching approvals off does not turn a "no" into a yes in this conversation.
  await service.setPreferences(owner, { enabled: false });
  const unasked = await call(
    owner,
    `/computer/${bot}`,
    snapshot({ threadId, args: { ref: "e9", snapshotId: 5 } }),
  );
  expect(unasked.status).toBe(400);
  expect(clicks).toEqual([]);
  await service.setPreferences(owner, { enabled: true });
  // Once the person has spoken again, the Bot may ask again.
  const asked = await call(
    owner,
    `/computer/${bot}`,
    snapshot({ threadId, saidAgain: true }),
  );
  expect(asked.status).toBe(202);
});

test("an equivalent action already waiting is not asked about twice", async () => {
  clicks.length = 0;
  const bot = `${prefix}-bot-${randomUUID()}`;
  const threadId = `${prefix}-duplicate-${randomUUID()}`;
  expect(
    (await call(owner, `/computer/${bot}`, snapshot({ threadId }))).status,
  ).toBe(202);
  const again = await call(
    owner,
    `/computer/${bot}`,
    snapshot({ threadId, args: { ref: "e7", snapshotId: 8 } }),
  );
  expect(again.status).toBe(400);
  expect(((await again.json()) as { error: string }).error).toBe(
    ALREADY_WAITING,
  );
  expect(await pendingFor(threadId)).toHaveLength(1);
});

test("switching approvals off withdraws what was only waiting on it, resumes the conversation, and runs nothing", async () => {
  clicks.length = 0;
  const bot = `${prefix}-bot-${randomUUID()}`;
  const threadId = `${prefix}-off-${randomUUID()}`;
  const waiting = await call(owner, `/computer/${bot}`, snapshot({ threadId }));
  const { approvalId } = (await waiting.json()) as { approvalId: string };
  await service.setPreferences(owner, { enabled: false });
  try {
    expect(await pendingFor(threadId)).toEqual([]);
    const continued = await resume(approvalId);
    expect(continued).toEqual([
      { content: WITHDRAWN_APPROVALS_OFF, error: WITHDRAWN_APPROVALS_OFF },
    ]);
    expect(clicks).toEqual([]);
    const [row] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "approval.withdrawn"),
          eq(auditEvents.targetId, approvalId),
        ),
      );
    expect(row?.payload).toMatchObject({ reason: WITHDRAWN_APPROVALS_OFF });
  } finally {
    await service.setPreferences(owner, { enabled: true });
  }
});

test("a new allow rule withdraws the requests it now covers", async () => {
  clicks.length = 0;
  const bot = `${prefix}-bot-${randomUUID()}`;
  const threadId = `${prefix}-rule-${randomUUID()}`;
  const waiting = await call(
    owner,
    `/computer/${bot}`,
    snapshot({
      threadId,
      toolName: "computer_type",
      args: { ref: "e2", snapshotId: 1, text: "Ada" },
    }),
  );
  const { approvalId } = (await waiting.json()) as { approvalId: string };
  await service.createRule(owner, {
    botId: bot,
    toolRef: "computer_type",
    effect: "*",
    scope: "*",
    behaviour: "allow",
  });
  expect(await pendingFor(threadId)).toEqual([]);
  expect(await resume(approvalId)).toEqual([
    { content: WITHDRAWN_RULE_ALLOWS, error: WITHDRAWN_RULE_ALLOWS },
  ]);
  expect(clicks).toEqual([]);
});

test("the trail tells a person's decision from the gate's own verdict", async () => {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, owner),
        inArray(auditEvents.eventType, [
          "approval.person_decided",
          "approval.evaluated",
        ]),
      ),
    );
  const person = rows.filter(
    (row) => row.eventType === "approval.person_decided",
  );
  const policy = rows.filter((row) => row.eventType === "approval.evaluated");
  expect(person.length).toBeGreaterThan(0);
  expect(policy.length).toBeGreaterThan(0);
  for (const row of person)
    expect(row.payload).toMatchObject({ decidedBy: "person" });
  for (const row of policy)
    expect(row.payload).toMatchObject({ decidedBy: "policy" });
  expect(
    person.map((row) => (row.payload as { decision: string }).decision),
  ).toEqual(expect.arrayContaining(["allow_once", "deny", "allow_always"]));
});
