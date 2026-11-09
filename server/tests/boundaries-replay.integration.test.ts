import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  createAuditReader,
  createAuditStore,
  type AuditEvent,
} from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ActionPolicy } from "../src/computer/policy";
import type { DryRunReport } from "../src/computer/policy-dry-run";
import { createPolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { PluginRefusedError } from "../src/plugins/plugin-store/model";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The boundaries backtest over real app calls, and the trail a saved boundary leaves.
 *
 * The calls are made through the real plugin store, against the real tables, so the rows replayed are
 * the rows `callTool` writes, not a test's idea of them; only the vendor is a seam. The replay is
 * asked for through the real route, over the real audit reader.
 *
 * The backtest used to read computer actions alone. A rule about an app, `mcp.server == "crm" &&
 * mcp.effect == "write"`, previewed as changing nothing at all, about a deployment whose Bots wrote to
 * that app every day.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const auditReader = createAuditReader(database);
const prefix = `boundaries-replay-${randomUUID()}`;
const APP = `${prefix}-crm`;
const BOT = `${prefix}-bot`;
const UNGRANTED_BOT = `${prefix}-other`;
const ADMIN = {
  id: `${prefix}-admin`,
  email: `${prefix}@example.test`,
  role: "admin" as const,
};

const ALLOW_ALL: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const NO_CRM_WRITES = `mcp.server == "${APP}" && mcp.effect == "write"`;

let live: ActionPolicy = ALLOW_ALL;
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => live,
  callVendor: async (_connection, toolName) =>
    toolName === "create_task"
      ? { text: "The caller does not have permission", isError: true }
      : { text: "done", isError: false },
});

const call = (tool: string, botId = BOT) =>
  plugins
    .callTool({
      ref: `${APP}/${tool}`,
      args: {},
      botId,
      actorId: ADMIN.id,
    })
    .then(
      () => "called",
      (error: unknown) =>
        error instanceof PluginRefusedError ? "refused" : Promise.reject(error),
    );

function app() {
  const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    await next();
  };
  const policyStore = createPolicyStore(ALLOW_ALL);
  const routes = createComputerRoutes(
    {} as never,
    policyStore,
    asAdmin,
    async () => false,
    undefined,
    auditReader,
    undefined,
    auditStore,
  );
  return {
    policyStore,
    app: new Hono<{ Variables: AppVariables }>().route(
      "/api/computers",
      routes,
    ),
  };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** This file's app-call rows, newest first, as the trail holds them. */
async function callRows() {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        inArray(sql<string>`${auditEvents.payload} ->> 'bot'`, [
          BOT,
          UNGRANTED_BOT,
        ]),
        sql`${auditEvents.eventType} like 'mcp.call_%'`,
      ),
    );
}

async function dryRun(candidate: ActionPolicy): Promise<DryRunReport> {
  // Exactly this file's rows: they are the newest replayable rows in the trail.
  const limit = (await callRows()).length;
  const response = await app().app.request(
    "http://t/api/computers/policy-dry-run",
    json("POST", { policy: candidate, limit }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { report: DryRunReport }).report;
}

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: APP,
    title: "CRM",
    vendor: "Acme",
    url: "https://crm.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values(
    [
      ["query_records", "read"],
      ["update_record", "write"],
      ["create_task", "write"],
    ].map(([name, effect]) => ({
      serverId: APP,
      name: name as string,
      vendorName: name as string,
      inputSchema: {},
      effect: effect as "read" | "write",
    })),
  );
  await database.insert(agents).values(
    [BOT, UNGRANTED_BOT].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  await database.insert(pluginGrants).values(
    ["query_records", "update_record", "create_task"].map((tool) => ({
      kind: "mcp" as const,
      ref: `${APP}/${tool}`,
      agentId: BOT,
    })),
  );

  // Under the policy that allows everything: a read, a write, and a write the vendor fails.
  live = ALLOW_ALL;
  expect(await call("query_records")).toBe("called");
  expect(await call("update_record")).toBe("called");
  expect(await call("create_task")).toBe("called");
  // The same write in trial mode: refused and let through, so one call writes two rows.
  live = { mode: "dry-run", deny: [NO_CRM_WRITES], allow: ["true"] };
  expect(await call("update_record")).toBe("called");
  // Enforced: refused, one row.
  live = { mode: "enforce", deny: [NO_CRM_WRITES], allow: ["true"] };
  expect(await call("update_record")).toBe("refused");
  // Never reached the boundary: this Bot was not given the tool.
  live = ALLOW_ALL;
  expect(await call("update_record", UNGRANTED_BOT)).toBe("refused");
});

afterAll(async () => {
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.delete(agents).where(inArray(agents.id, [BOT, UNGRANTED_BOT]));
  await database.$client.close();
});

describe("replaying app calls", () => {
  test("the trail holds what the calls wrote, a trial-mode call as two rows of one attempt", async () => {
    const rows = await callRows();
    expect(rows.map((row) => row.eventType).sort()).toEqual(
      [
        "mcp.call_succeeded",
        "mcp.call_succeeded",
        "mcp.call_failed",
        "mcp.call_rejected",
        "mcp.call_succeeded",
        "mcp.call_rejected",
        "mcp.call_rejected",
      ].sort(),
    );
    const trial = rows.filter(
      (row) =>
        (row.payload as { decision?: { mode?: string } }).decision?.mode ===
        "dry-run",
    );
    expect(trial.map((row) => row.eventType).sort()).toEqual([
      "mcp.call_rejected",
      "mcp.call_succeeded",
    ]);
    const [first, second] = trial.map(
      (row) => (row.payload as { attempt?: string }).attempt,
    );
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });

  test("a rule about an app's writes reports exactly the writes it would now stop, each once", async () => {
    const report = await dryRun({ ...ALLOW_ALL, deny: [NO_CRM_WRITES] });

    // Five calls reached the boundary; the trial-mode call is one of them, and the call to a Bot
    // that was never given the tool is none of them.
    expect(report.scanned).toBe(5);
    expect(report.wouldRefuse).toBe(2);
    expect(report.wouldAllow).toBe(0);
    expect(report.unchanged).toBe(3);
    expect(
      report.changes.map((change) => [change.kind, change.action, change.was]),
    ).toEqual([
      ["app", `${APP}/create_task`, "allowed"],
      ["app", `${APP}/update_record`, "allowed"],
    ]);
    for (const change of report.changes) {
      expect(change).toMatchObject({
        bot: BOT,
        would: "refused",
        rule: NO_CRM_WRITES,
        initiator: { kind: "person", id: "" },
      });
    }
  });

  test("lifting the rule scores the trial-mode call once, not once per row", async () => {
    const report = await dryRun(ALLOW_ALL);
    expect(report.scanned).toBe(5);
    // The enforced refusal, and the trial-mode refusal, which wrote two rows.
    expect(report.wouldAllow).toBe(2);
    expect(new Set(report.changes.map((change) => change.id)).size).toBe(2);
    expect(report.changes.every((change) => change.kind === "app")).toBe(true);
  });
});

describe("saving a boundary is on the trail", () => {
  async function saved(): Promise<AuditEvent[]> {
    const { events } = await auditReader.list({
      limit: 10,
      eventType: "computer.policy_changed",
      actorUserId: ADMIN.id,
    });
    return events;
  }

  test("with the rules it changed, before and after, and the English it was written from", async () => {
    const { app: routes } = app();
    const text = "Nothing may change anything in the CRM.";
    const response = await routes.request(
      "http://t/api/computers/policy",
      json("PUT", {
        ...ALLOW_ALL,
        deny: [NO_CRM_WRITES],
        labels: {
          [NO_CRM_WRITES]: { name: "Never change the CRM", description: "" },
        },
        authoring: { source: "english", text },
      }),
    );
    expect(response.status).toBe(200);

    const [event] = await saved();
    expect(event).toMatchObject({
      eventType: "computer.policy_changed",
      targetType: "policy",
      actorUserId: ADMIN.id,
      payload: {
        by: ADMIN.email,
        added: [
          { list: "deny", rule: NO_CRM_WRITES, name: "Never change the CRM" },
        ],
        removed: [],
        mode: { before: "enforce", after: "enforce" },
        before: { deny: [], allow: ["true"] },
        after: { deny: [NO_CRM_WRITES], allow: ["true"] },
        authoring: { source: "english", text },
      },
    });
  });

  test("without authoring when the rule was written by hand, and on every save", async () => {
    const { app: routes, policyStore } = app();
    await policyStore.set({ ...ALLOW_ALL, deny: [NO_CRM_WRITES] });
    const response = await routes.request(
      "http://t/api/computers/policy",
      json("PUT", { ...ALLOW_ALL, mode: "dry-run", deny: [] }),
    );
    expect(response.status).toBe(200);

    const [event] = await saved();
    expect(event?.payload).toMatchObject({
      added: [],
      removed: [{ list: "deny", rule: NO_CRM_WRITES }],
      mode: { before: "enforce", after: "dry-run" },
    });
    expect(event?.payload).not.toHaveProperty("authoring");
  });

  test("a save that is refused leaves no row, and malformed authoring is refused", async () => {
    const before = (await saved()).length;
    const { app: routes } = app();
    const broken = await routes.request(
      "http://t/api/computers/policy",
      json("PUT", { ...ALLOW_ALL, deny: ['elemnt.name == "x"'] }),
    );
    expect(broken.status).toBe(400);
    const authoring = await routes.request(
      "http://t/api/computers/policy",
      json("PUT", { ...ALLOW_ALL, authoring: { source: "french", text: "x" } }),
    );
    expect(authoring.status).toBe(400);
    expect((await saved()).length).toBe(before);
  });
});
