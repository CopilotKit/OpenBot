/**
 * The audit trail, action records and model usage live in Intelligence: this deployment's
 * `audit_events`, `action_records` and `model_usage` tables get no writes.
 *
 * The three tables stay for one release so an upgrading deployment has rows to copy, and are read
 * only by that copy (`audit-trail/upgrade.ts`). Two guards: no server source outside the copy and the
 * schema names them, and writing an event, an action record and a model usage row through the stores
 * leaves all three tables as they were while Intelligence holds each one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count } from "drizzle-orm";
import { createEnterpriseStore } from "../src/admin/settings-store";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { actionRecords, auditEvents, modelUsage } from "../src/db/schema";
import {
  actionRows,
  auditRows,
  modelUsageRows,
  useTestAuditTrail,
} from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { sourceFiles, stripComments } from "./support/source-scan";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
useTestAuditTrail();

afterAll(async () => {
  await database.$client.close();
});

describe("the legacy audit, action and usage tables", () => {
  test("no server source names them except the upgrade copy and the schema", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set([
      "audit-trail/upgrade.ts",
      "db/schema/core.ts",
      "db/schema/admin.ts",
    ]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path)) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      return /\bauditEvents\b|\bactionRecords\b|\bmodelUsage\b|\b(?:from|into|update|table)\s+"?(?:audit_events|action_records|model_usage)\b/i.test(
        code,
      )
        ? [path]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  test("an event, an action record and a model usage row written through the stores reach Intelligence and nothing here", async () => {
    const suite = randomUUID();
    const bot = `no-local-writes-${suite}`;
    const before = await tableCounts();

    await createAuditStore(database).insert({
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: bot,
      payload: { bot, action: "computer_run_command" },
    });
    const enterprise = createEnterpriseStore(database);
    await enterprise.recordAction({
      surface: "cloud",
      botId: bot,
      actorUserId: null,
      toolName: "computer_run_command",
      command: "echo hello",
      outcome: "allowed",
    });
    await enterprise.recordModelUsage({
      agentId: bot,
      model: "openai/gpt-local-writes",
      source: "configured",
      allowed: true,
    });

    expect(await auditRows({ targetId: bot })).toMatchObject([
      { eventType: "computer.action_allowed", agentId: bot },
    ]);
    expect(await actionRows(bot)).toMatchObject([
      { command: "echo hello", outcome: "allowed" },
    ]);
    expect(await modelUsageRows(bot)).toMatchObject([
      { model: "openai/gpt-local-writes", allowed: true },
    ]);
    expect(await tableCounts()).toEqual(before);
  });
});

async function tableCounts() {
  const [events] = await database.select({ n: count() }).from(auditEvents);
  const [actions] = await database.select({ n: count() }).from(actionRecords);
  const [usage] = await database.select({ n: count() }).from(modelUsage);
  return { events: events?.n, actions: actions?.n, usage: usage?.n };
}
