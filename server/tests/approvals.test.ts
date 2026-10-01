import { expect, test } from "bun:test";
import * as serviceModule from "../src/approvals/service";
import {
  approvalAction,
  type ApprovalAction,
  type ApprovalRecord,
  type ApprovalStore,
  ApprovalRefusedError,
  ApprovalNotFoundError,
  withApprovalContext,
} from "../src/approvals/types";
import { createComputerGateway } from "../src/computer/gateway";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createHostAccessBroker } from "../src/host-access/broker";

const context = {
  runId: "run",
  threadId: "thread",
  toolCallId: "call",
  toolName: "computer_click",
  args: { ref: "e1", snapshotId: 7 },
  messages: [],
  state: {},
  context: [],
  forwardedProps: {},
};
const candidate = {
  actorId: "owner",
  botId: "bot",
  toolRef: "computer_click",
  effect: "write",
  scope: "example.com",
  args: context.args,
  target: { ref: "e1", snapshotId: 7, name: "Submit" },
  continuation: context,
};

function storeFixture() {
  const records = new Map<string, ApprovalRecord>();
  const rules: {
    id: string;
    ownerUserId: string;
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    revokedAt: Date | null;
    createdAt: Date;
  }[] = [];
  let enabled = true;
  const require = (owner: string, id: string) => {
    const row = records.get(id);
    if (!row || row.ownerUserId !== owner) throw new ApprovalNotFoundError();
    return row;
  };
  const store: ApprovalStore = {
    enabled: async () => enabled,
    setEnabled: async (_owner, value) => {
      enabled = value;
    },
    open: async (action: ApprovalAction) => {
      const prior = [...records.values()].find(
        (row) =>
          row.ownerUserId === action.actorId &&
          row.action.runId === action.runId &&
          row.action.toolCallId === action.toolCallId,
      );
      if (prior) {
        if (prior.action.actionDigest !== action.actionDigest)
          throw new ApprovalRefusedError("The approved action has changed.");
        return structuredClone(prior);
      }
      const rule = rules.find(
        (rule) =>
          rule.ownerUserId === action.actorId &&
          rule.botId === action.botId &&
          rule.toolRef === action.toolRef &&
          rule.effect === action.effect &&
          rule.scope === action.scope &&
          !rule.revokedAt,
      );
      const row: ApprovalRecord = {
        id: crypto.randomUUID(),
        ownerUserId: action.actorId,
        action: structuredClone(action),
        status: rule ? "approved" : "pending",
        decision: rule ? "allow_always" : null,
        result: null,
        createdAt: new Date(),
        decidedAt: rule ? new Date() : null,
        consumedAt: null,
        completedAt: null,
      };
      records.set(row.id, row);
      return structuredClone(row);
    },
    get: async (owner, id) => structuredClone(require(owner, id)),
    list: async (owner) =>
      [...records.values()]
        .filter((row) => row.ownerUserId === owner)
        .map((row) => structuredClone(row)),
    decide: async (owner, id, decision) => {
      const row = require(owner, id);
      if (row.status !== "pending")
        throw new ApprovalRefusedError("This request was already decided.");
      row.decision = decision;
      row.status = decision === "deny" ? "denied" : "approved";
      row.decidedAt = new Date();
      if (decision === "allow_always")
        rules.push({
          id: crypto.randomUUID(),
          ownerUserId: owner,
          botId: row.action.botId,
          toolRef: row.action.toolRef,
          effect: row.action.effect,
          scope: row.action.scope,
          revokedAt: null,
          createdAt: new Date(),
        });
      return structuredClone(row);
    },
    consume: async (owner, id, digest) => {
      const row = require(owner, id);
      if (row.action.actionDigest !== digest)
        throw new ApprovalRefusedError("The approved action has changed.");
      if (row.status !== "approved") return false;
      if (
        row.decision === "allow_always" &&
        !rules.some(
          (rule) =>
            !rule.revokedAt &&
            rule.toolRef === row.action.toolRef &&
            rule.scope === row.action.scope,
        )
      )
        return false;
      row.status = "consumed";
      row.consumedAt = new Date();
      return true;
    },
    saveResult: async (owner, id, result) => {
      require(owner, id).result = result;
    },
    finish: async (owner, id) => {
      require(owner, id).status = "completed";
      require(owner, id).completedAt = new Date();
    },
    rules: async (owner) =>
      structuredClone(rules.filter((rule) => rule.ownerUserId === owner)),
    revoke: async (owner, id) => {
      const rule = rules.find(
        (rule) => rule.id === id && rule.ownerUserId === owner,
      );
      if (!rule) throw new ApprovalNotFoundError();
      rule.revokedAt = new Date();
    },
  };
  return store;
}

test("personal approval forwards the exact side effect once and continues its original AG-UI tool result after service restart", async () => {
  expect(typeof serviceModule.createApprovalService).toBe("function");
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  await expect(service.gate(candidate)).rejects.toMatchObject({
    name: "HeadlessToolSuspension",
  });
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing request");
  await expect(
    service.decide("intruder", row.id, "allow_once"),
  ).rejects.toThrow();
  await service.decide("owner", row.id, "allow_once");
  const restarted = serviceModule.createApprovalService(store);
  let effects = 0;
  const continued: unknown[] = [];
  const dependencies = {
    validate: async () => approvalAction(candidate),
    execute: async () => {
      effects += 1;
      return "clicked";
    },
    continue: async (value: unknown) => {
      continued.push(value);
    },
  };
  await restarted.resume("owner", row.id, dependencies);
  await restarted.resume("owner", row.id, dependencies);
  expect(effects).toBe(1);
  expect(continued).toHaveLength(1);
  expect(continued[0]).toMatchObject({
    continuation: { runId: "run", threadId: "thread", toolCallId: "call" },
    result: { content: "clicked" },
  });
});

test("current authority and a changed resolved target defeat an earlier approval", async () => {
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  await expect(service.gate(candidate)).rejects.toThrow();
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing request");
  await service.decide("owner", row.id, "allow_once");
  let effects = 0;
  await expect(
    service.resume("owner", row.id, {
      validate: async () => {
        throw new Error("grant revoked");
      },
      execute: async () => {
        effects += 1;
      },
      continue: async () => undefined,
    }),
  ).rejects.toThrow("grant revoked");
  await expect(
    service.resume("owner", row.id, {
      validate: async () =>
        approvalAction({
          ...candidate,
          target: { ref: "e1", name: "Delete", snapshotId: 8 },
        }),
      execute: async () => {
        effects += 1;
      },
      continue: async () => undefined,
    }),
  ).rejects.toThrow("changed");
  expect(effects).toBe(0);
});

test("always is scoped and revocable, while deny stays durable", async () => {
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  await expect(service.gate(candidate)).rejects.toThrow();
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing request");
  await service.decide("owner", row.id, "allow_always");
  await service.gate({
    ...candidate,
    continuation: { ...context, runId: "new-run", toolCallId: "new-call" },
  });
  const [rule] = await store.rules("owner");
  if (!rule) throw new Error("missing rule");
  await service.revoke("owner", rule.id);
  await expect(
    service.gate({
      ...candidate,
      continuation: { ...context, runId: "third-run" },
    }),
  ).rejects.toThrow();
  const pending = (await store.list("owner")).find(
    (request) => request.status === "pending",
  );
  if (!pending) throw new Error("missing pending");
  await service.decide("owner", pending.id, "deny");
  await expect(
    service.gate({
      ...candidate,
      continuation: { ...context, runId: "third-run" },
    }),
  ).rejects.toThrow("declined");
});

test("computer policy runs before personal approval and simultaneous once requests forward only one real command", async () => {
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  let forwards = 0;
  let denied = false;
  const gateway = createComputerGateway({
    provider: {
      name: "test",
      isolation: "per-bot",
      locate: async () => "http://computer:4100",
      status: async (botId) => ({ botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    },
    policy: () => ({
      mode: "enforce",
      allow: ["true"],
      deny: denied ? ["true"] : [],
    }),
    auditStore: { insert: async () => undefined },
    approvalGate: service.gate,
    fetchImpl: async () => {
      forwards += 1;
      return Response.json({
        command: "pwd",
        exitCode: 0,
        stdout: "workspace",
        stderr: "",
        elapsedMs: 1,
        timedOut: false,
        truncated: false,
      });
    },
  });
  const invoke = () =>
    withApprovalContext(
      {
        ...context,
        toolName: "computer_run_command",
        args: { command: "pwd" },
      },
      () =>
        gateway.runCommand(
          "bot",
          { id: "owner", userId: "owner" },
          { command: "pwd" },
        ),
    );
  await expect(invoke()).rejects.toMatchObject({
    name: "HeadlessToolSuspension",
  });
  expect(forwards).toBe(0);
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing approval");
  await service.decide("owner", row.id, "allow_once");
  const outcomes = await Promise.allSettled([invoke(), invoke()]);
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  expect(forwards).toBe(1);
  const stored = await store.get("owner", row.id);
  const validated = await service.validateReentry(stored.action, invoke);
  expect(validated.actionDigest).toBe(stored.action.actionDigest);
  expect(forwards).toBe(1);
  denied = true;
  await expect(
    withApprovalContext({ ...context, runId: "other" }, () =>
      gateway.runCommand("bot", { id: "owner" }, { command: "pwd" }),
    ),
  ).rejects.toThrow();
  expect(await store.list("owner")).toHaveLength(1);
});

test("native host approval queues one operation, replays its saved result, and respects revoked grants", async () => {
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  const broker = createHostAccessBroker(Date.now, {
    approvalGate: service.gate,
  });
  broker.nextDesktopOperation();
  broker.rememberGrant({
    id: "folder",
    actorId: "owner",
    botId: "bot",
    displayName: "Project",
    revoked: false,
  });
  const args = {
    kind: "write_file" as const,
    botId: "bot",
    actorId: "owner",
    grantId: "folder",
    relativePath: "notes.txt",
    content: "private file",
  };
  const invoke = () =>
    withApprovalContext({ ...context, toolName: "host_write_file", args }, () =>
      broker.callHost(args),
    );
  await expect(invoke()).rejects.toMatchObject({
    name: "HeadlessToolSuspension",
  });
  expect(broker.statusFor("owner").pending).toHaveLength(0);
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing request");
  await service.decide("owner", row.id, "allow_once");
  const running = invoke();
  for (
    let attempt = 0;
    attempt < 20 && broker.statusFor("owner").pending.length === 0;
    attempt += 1
  )
    await Bun.sleep(1);
  const operation = broker.nextDesktopOperation()?.operations[0];
  if (!operation) throw new Error("missing operation");
  broker.resolveDesktopOperation({
    operationId: operation.operationId,
    ok: true,
    result: { saved: true },
  });
  await expect(running).resolves.toEqual({ saved: true });
  await expect(invoke()).resolves.toEqual({ saved: true });
  expect(broker.statusFor("owner").pending).toHaveLength(0);
  broker.revokeGrant("folder", "owner");
  await expect(invoke()).rejects.toThrow("no longer available");
});

test("owner inbox exposes sanitized context and rejects another owner's decisions", async () => {
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  await expect(
    service.gate({
      ...candidate,
      args: {
        token: "secret-value",
        content: "private-body",
        command: "API_TOKEN=credential echo ok",
      },
    }),
  ).rejects.toThrow();
  const routesFor = (owner: string) =>
    createApprovalRoutes(service, async (ctx, next) => {
      ctx.set("actor", {
        id: owner,
        email: `${owner}@example.com`,
        role: "user",
      });
      await next();
    });
  const own = routesFor("owner");
  const other = routesFor("intruder");
  const response = await own.request("/");
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain("secret-value");
  expect(body).not.toContain("private-body");
  expect(body).not.toContain("credential");
  expect(body).not.toContain("continuation");
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing request");
  const result = await other.request(`/${row.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "allow_once" }),
  });
  expect(result.status).toBe(404);
  expect((await store.get("owner", row.id)).status).toBe("pending");
  expect(await (await other.request("/")).json()).toMatchObject({
    requests: [],
    rules: [],
  });
});

test("a crash after consuming an approval never repeats an action with an unknown outcome", async () => {
  const store = storeFixture();
  const service = serviceModule.createApprovalService(store);
  await expect(service.gate(candidate)).rejects.toThrow();
  const [row] = await store.list("owner");
  if (!row) throw new Error("missing request");
  await service.decide("owner", row.id, "allow_once");
  await store.consume("owner", row.id, row.action.actionDigest);
  let effects = 0;
  await expect(
    service.resume("owner", row.id, {
      validate: async () => row.action,
      execute: async () => {
        effects += 1;
      },
      continue: async () => undefined,
    }),
  ).rejects.toThrow("outcome is unknown");
  expect(effects).toBe(0);
});
