import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import {
  createApprovalService,
  DECLINED_BY_PERSON,
} from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalAction,
  type ApprovalContinuation,
  ApprovalRefusedError,
  parseApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import { createAuditStore } from "../src/audit";
import { botSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { dataFunction } from "../src/components/functions";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import { dryRunAgainstHistory } from "../src/computer/policy-dry-run";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { createPluginStore } from "../src/plugins/store";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What the trail says about a Bot's file actions when "Ask before making changes" is on: a write the
 * person denies, a write they allow, and a read that fails. Real approval store, real gateway writing
 * to the real audit table, the person's own chat posting the call over HTTP; the computer is a local
 * fetch seam that counts what reached it.
 *
 * The trail used to record the write as allowed and carried out BEFORE the person was asked, so a
 * denied write read "Allowed" on the Audit page and the Blocked view never showed it, and an allowed
 * write left three "allowed" rows behind it (the ask, the re-check, the run).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `audit-outcomes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const store = createApprovalStore(database);
const written: string[] = [];

const gateway = createComputerGateway({
  provider: {
    name: "test",
    isolation: "per-person",
    locate: async () => "http://computer:4100",
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
  },
  auditStore: createAuditStore(database),
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: (candidate) => service.gate(candidate),
  fetchImpl: Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (path === "/files/write") {
        written.push(body.path);
        return Response.json({ path: body.path, bytes: 2, appended: false });
      }
      if (path === "/files/read")
        return Response.json(
          { error: `${body.path} does not exist in the workspace.` },
          { status: 404 },
        );
      throw new Error(`Unexpected ${path}`);
    },
    { preconnect: fetch.preconnect },
  ),
});
const run = (snapshot: ApprovalContinuation, botId: string) => {
  const tool = createHeadlessComputerTools({
    gateway,
    seat: botSeat(botId),
    actor: { id: owner, userId: owner, initiator: { kind: "person" } },
  }).find((candidate) => candidate.definition.name === snapshot.toolName);
  if (!tool) throw new Error("no tool");
  return tool.execute(snapshot.args, {
    toolCallId: snapshot.toolCallId,
    signal: new AbortController().signal,
  });
};
const service = createApprovalService(store, undefined, (_actor, bot, snap) =>
  run(snap, bot),
);
const execute = (action: ApprovalAction) =>
  run(parseApprovalContinuation(action.continuation), action.botId);

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/approvals",
  createApprovalRoutes(service, async (context, next) => {
    context.set("actor", {
      id: owner,
      email: `${owner}@example.test`,
      role: "user",
    });
    await next();
  }),
);
const post = (path: string, body: unknown) =>
  app.request(`/api/approvals${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function call(
  toolName: string,
  args: Record<string, unknown>,
): ApprovalContinuation {
  const toolCallId = randomUUID();
  return {
    runId: randomUUID(),
    threadId: `${prefix}-thread-${randomUUID()}`,
    toolCallId,
    toolName,
    args,
    messages: [
      { id: "u1", role: "user", content: "Save a note for me" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(args) },
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

/** Every row this Bot's actions and decisions left, oldest first. */
async function trailFor(bot: string) {
  return database
    .select({
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(eq(sql<string>`${auditEvents.payload} ->> 'bot'`, bot))
    .orderBy(asc(auditEvents.createdAt));
}

/** The decision rows and the action rows about one file, as event types, oldest first. */
const typesAbout = (rows: Awaited<ReturnType<typeof trailFor>>, file: string) =>
  rows
    .filter((row) => (row.payload as { file?: string }).file === file)
    .map((row) => row.eventType);

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await store.setEnabled(owner, true);
});
afterAll(async () => {
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.delete(agents).where(eq(agents.id, APP_BOT));
  const ids = (await store.list(owner)).map((request) => request.id);
  if (ids.length)
    await database
      .delete(workItems)
      .where(
        and(eq(workItems.kind, "approval.resume"), inArray(workItems.key, ids)),
      );
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

test("a write the person denies is on the trail as refused, never as allowed or carried out", async () => {
  const bot = `${prefix}-deny`;
  written.length = 0;
  const pending = await post(
    `/computer/${bot}`,
    call("computer_write_file", { path: "refused.txt", contents: "no" }),
  );
  expect(pending.status).toBe(202);
  const { approvalId } = (await pending.json()) as { approvalId: string };

  // Asked, and nothing attempted yet: no row may say the write was sent.
  expect(typesAbout(await trailFor(bot), "refused.txt")).toEqual([
    "approval.evaluated",
  ]);

  await post(`/${approvalId}/decision`, { decision: "deny" });
  expect(await resume(approvalId)).toEqual([
    { content: DECLINED_BY_PERSON, error: DECLINED_BY_PERSON },
  ]);
  expect(written).toEqual([]);

  const rows = await trailFor(bot);
  expect(typesAbout(rows, "refused.txt")).toEqual([
    "approval.evaluated",
    "approval.person_decided",
    "computer.action_refused",
  ]);
  const decided = rows.find(
    (row) => row.eventType === "approval.person_decided",
  );
  expect(decided?.payload).toMatchObject({
    decision: "deny",
    file: "refused.txt",
  });
  const refused = rows.find(
    (row) => row.eventType === "computer.action_refused",
  );
  expect(refused?.payload).toMatchObject({
    action: "computer_write_file",
    file: "refused.txt",
    refusal: "person_declined",
    reason: DECLINED_BY_PERSON,
    // The policy's own verdict is kept as it was; what did not happen is said beside it.
    decision: { allowed: true, carriedOut: false },
  });

  // A component listing recent refusals shows it in a person's words, not the Bot's instruction.
  const refusals = await dataFunction("recentRefusals")?.run(database, {
    limit: 50,
  });
  expect(
    (refusals as { rows: { bot: string; reason: string | null }[] }).rows.find(
      (entry) => entry.bot === bot,
    ),
  ).toMatchObject({ reason: "You declined it." });
});

test("a write the person allows is recorded once, when it runs, after the decision", async () => {
  const bot = `${prefix}-allow`;
  written.length = 0;
  const pending = await post(
    `/computer/${bot}`,
    call("computer_write_file", { path: "allowed.txt", contents: "ok" }),
  );
  const { approvalId } = (await pending.json()) as { approvalId: string };
  expect(typesAbout(await trailFor(bot), "allowed.txt")).toEqual([
    "approval.evaluated",
  ]);

  await post(`/${approvalId}/decision`, { decision: "allow_once" });
  // Carried out: an answer with no error on it.
  expect(await resume(approvalId)).toEqual([{ content: expect.any(String) }]);
  expect(written).toEqual(["allowed.txt"]);

  // One attempt row, not one for the ask, one for the re-check and one for the run.
  expect(typesAbout(await trailFor(bot), "allowed.txt")).toEqual([
    "approval.evaluated",
    "approval.person_decided",
    "computer.action_allowed",
  ]);
});

test("a read that fails is one attempt and its failure, tied together", async () => {
  const bot = `${prefix}-fail`;
  await post(
    `/computer/${bot}`,
    call("computer_read_file", { path: "missing-report.txt" }),
  );

  const rows = (await trailFor(bot)).filter(
    (row) => (row.payload as { file?: string }).file === "missing-report.txt",
  );
  expect(rows.map((row) => row.eventType)).toEqual([
    "computer.action_allowed",
    "computer.action_failed",
  ]);
  const [attempt, failure] = rows.map(
    (row) => (row.payload as { attempt?: string }).attempt,
  );
  expect(attempt).toEqual(expect.any(String));
  expect(failure).toBe(attempt);
});

test("a person's denial is not replayed as a refusal the policy made", async () => {
  const bot = `${prefix}-deny`;
  const rows = (await trailFor(bot)).filter((row) =>
    row.eventType.startsWith("computer.action_"),
  );
  expect(rows.map((row) => row.eventType)).toEqual(["computer.action_refused"]);
  // The same policy over the denial changes nothing: it allowed the write, and still would.
  const report = dryRunAgainstHistory(
    { mode: "enforce", allow: ["true"], deny: [] },
    rows.map((row) => ({
      id: randomUUID(),
      actorUserId: owner,
      initiatorKind: "person",
      initiatorId: null,
      eventType: row.eventType,
      targetType: "computer",
      targetId: bot,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    })),
  );
  expect(report).toMatchObject({ scanned: 1, unchanged: 1, wouldAllow: 0 });
});

/*
 * The other acting surface: a write to an app. It asks first, through the same gate; a denial is
 * recorded as that app call refused, and a retry the gate turns away is recorded too. Neither ever
 * reaches the vendor. A real plugin store over the real tables; the vendor is the `callVendor` seam.
 */
const APP = `${prefix}-notes`;
const APP_BOT = `${prefix}-app-bot`;
const APP_TOOL = `${APP}/create_note`;
const vendorCalls: string[] = [];
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  approvalGate: (candidate) => service.gate(candidate),
  callVendor: async (_connection, toolName) => {
    vendorCalls.push(toolName);
    return { text: "created", isError: false };
  },
});

function appCall(threadId: string, saidAgain = false): ApprovalContinuation {
  const toolCallId = randomUUID();
  const args = { title: "Friday" };
  return {
    runId: randomUUID(),
    threadId,
    toolCallId,
    toolName: `mcp__${APP}__create_note`,
    args,
    messages: [
      { id: "u1", role: "user", content: "Make a note for Friday" },
      ...(saidAgain
        ? [{ id: "u2", role: "user" as const, content: "Try that again" }]
        : []),
    ],
    state: {},
    context: [],
    forwardedProps: {},
  };
}
const callApp = (continuation: ApprovalContinuation) =>
  withApprovalContext(continuation, () =>
    plugins.callTool({
      ref: APP_TOOL,
      args: { title: "Friday" },
      botId: APP_BOT,
      actorId: owner,
    }),
  );

test("an app write the person denies is on the trail as a refused call, and so is a retry", async () => {
  await database.insert(mcpServers).values({
    id: APP,
    title: "Team Notes",
    vendor: "Acme",
    url: "https://notes.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: APP,
    name: "create_note",
    vendorName: "create_note",
    inputSchema: {},
    effect: "write",
  });
  await database.insert(agents).values({
    id: APP_BOT,
    name: "Notes",
    type: "built_in",
    configuration: {},
  });
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref: APP_TOOL, agentId: APP_BOT });

  const threadId = `${prefix}-app-${randomUUID()}`;
  const asked = await callApp(appCall(threadId)).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(asked).toBeInstanceOf(HeadlessToolSuspension);
  const [request] = (await store.list(owner)).filter(
    (row) => row.action.threadId === threadId,
  );
  if (!request) throw new Error("the app write was not asked about");
  await service.decide(owner, request.id, "deny");

  // The Bot tries the same thing again before the person has said anything more.
  const retried = await callApp(appCall(threadId)).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(retried).toBeInstanceOf(ApprovalRefusedError);
  expect(vendorCalls).toEqual([]);

  const rows = (await trailFor(APP_BOT)).filter((row) =>
    row.eventType.startsWith("mcp.call_"),
  );
  expect(rows.map((row) => row.eventType)).toEqual([
    "mcp.call_rejected",
    "mcp.call_rejected",
  ]);
  expect(
    rows.map((row) => (row.payload as { refusal?: string }).refusal),
  ).toEqual(["person_declined", "approval"]);
  for (const row of rows)
    expect(row.payload).toMatchObject({
      tool: "create_note",
      decision: { carriedOut: false },
      reason: DECLINED_BY_PERSON,
    });

  // An app write the person allows is still carried out and recorded as it was.
  const allowedThread = `${prefix}-app-${randomUUID()}`;
  await callApp(appCall(allowedThread)).catch(() => undefined);
  const [allowed] = (await store.list(owner)).filter(
    (row) => row.action.threadId === allowedThread,
  );
  if (!allowed) throw new Error("the second app write was not asked about");
  await service.decide(owner, allowed.id, "allow_once");
  await service.resume(owner, allowed.id, {
    validate: (action) =>
      service.validateReentry(action, () =>
        callApp(parseApprovalContinuation(action.continuation)),
      ),
    execute: (action) =>
      callApp(parseApprovalContinuation(action.continuation)),
    continue: async () => undefined,
  });
  expect(vendorCalls).toEqual(["create_note"]);
  expect(
    (await trailFor(APP_BOT))
      .filter((row) => row.eventType.startsWith("mcp.call_"))
      .map((row) => row.eventType),
  ).toEqual(["mcp.call_rejected", "mcp.call_rejected", "mcp.call_succeeded"]);
});
