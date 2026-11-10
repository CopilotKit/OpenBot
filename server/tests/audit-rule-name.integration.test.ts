import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { botSeat } from "../src/computer/computer-key";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createPolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
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
 * A refusal names the rule that made it, as the Boundaries page names it.
 *
 * A boundary written from a sentence is a CEL expression of about a thousand characters. The trail
 * recorded only that expression, so the Audit page's "Blocked" row was a wall of CEL that named
 * nothing, while the admin had saved the rule as "Bots may not visit social media sites". Now the
 * decision carries `ruleName` beside `rule`.
 *
 * Real paths: the rule is saved through the route the Boundaries page calls, a computer action is
 * refused by the real gateway and an app call by the real plugin store, and the rows read back are
 * the ones written to the audit table. Only the computer and the vendor are seams.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const prefix = `audit-rule-name-${randomUUID()}`;
const APP = `${prefix}-crm`;
const BOT = `${prefix}-bot`;
const ADMIN = {
  id: `${prefix}-admin`,
  email: `${prefix}@example.test`,
  role: "admin" as const,
};

const SITES = [
  ["facebook", "com"],
  ["x", "com"],
  ["twitter", "com"],
  ["instagram", "com"],
  ["linkedin", "com"],
  ["tiktok", "com"],
  ["reddit", "com"],
  ["snapchat", "com"],
  ["pinterest", "com"],
  ["threads", "net"],
  ["bsky", "app"],
  ["tumblr", "com"],
  ["mastodon", "social"],
  ["youtube", "com"],
] as const;

/** The social media rule as the plain-English translator writes it: one clause per site. */
const SOCIAL = `intent == "navigate" && (${SITES.map(
  ([name, tld]) =>
    `page.host == "${name}.${tld}" || matches(page.host, "[.]${name}[.]${tld}$")`,
).join(" || ")})`;
const SOCIAL_NAME = "Bots may not visit social media sites";

const CRM_WRITES = `mcp.server == "${APP}" && mcp.effect == "write"`;
const CRM_NAME = "Bots may not change records in the CRM";

/** A rule saved without a name, as every rule was before rules had them. */
const UNNAMED = 'intent == "navigate" && page.host == "unnamed.example"';

const ALLOW_ALL: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** In memory, so this file never touches the deployment-wide policy row other files reset. */
const policyStore = createPolicyStore(ALLOW_ALL);

const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { ...ADMIN });
  await next();
};

const routes = new Hono<{ Variables: AppVariables }>().route(
  "/api/computers",
  createComputerRoutes(
    {} as never,
    policyStore,
    asAdmin,
    async () => false,
    undefined,
    undefined,
    undefined,
    auditStore,
  ),
);

/** A computer that answers whatever it is asked. The policy refuses before anything reaches it. */
const provider: ComputerProvider = {
  name: "test",
  isolation: "per-person",
  locate: async () => "http://agent-computer:4100",
  status: async (seat) => ({ botId: seat.botId, state: "ready" }),
  stop: async () => ({ wasRunning: true }),
  reset: async () => ({ cleared: true }),
  list: async () => [],
};
const gateway = createComputerGateway({
  provider,
  fetchImpl: (async () =>
    Response.json({
      url: "https://example.com/",
      title: "",
      elapsedMs: 1,
    })) as unknown as typeof fetch,
  auditStore,
  policy: () => policyStore.get(),
});

const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => policyStore.get(),
  callVendor: async () => ({ text: "done", isError: false }),
});

/** This file's refusal rows, as the trail holds them. */
async function refusals(eventType: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, eventType),
        sql`${auditEvents.payload} ->> 'bot' = ${BOT}`,
      ),
    );
}

type Decision = { rule?: unknown; ruleName?: unknown; allowed?: unknown };
const decisionOf = (row: { payload: unknown }) =>
  (row.payload as { decision?: Decision }).decision ?? {};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: APP,
    title: "CRM",
    vendor: "Acme",
    url: "https://crm.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: APP,
    name: "update_record",
    vendorName: "update_record",
    inputSchema: {},
    effect: "write",
  });
  await database.insert(agents).values({
    id: BOT,
    name: BOT,
    type: "built_in",
    configuration: {},
  });
  await database.insert(pluginGrants).values({
    kind: "mcp",
    ref: `${APP}/update_record`,
    agentId: BOT,
  });

  // Saved as the Boundaries page saves it: the rules, and each one's name and what it stops.
  const saved = await routes.request("http://t/api/computers/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "enforce",
      deny: [SOCIAL, CRM_WRITES, UNNAMED],
      allow: ["true"],
      labels: {
        [SOCIAL]: {
          name: SOCIAL_NAME,
          description:
            "Stops a Bot opening Facebook, X, Instagram and the like.",
        },
        [CRM_WRITES]: {
          name: CRM_NAME,
          description: "Stops a Bot writing to the CRM.",
        },
      },
    }),
  });
  expect(saved.status).toBe(200);
});

afterAll(async () => {
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.delete(agents).where(inArray(agents.id, [BOT]));
  await database.$client.close();
});

describe("a refusal's audit row names the rule", () => {
  test("the rule is as long as one written from a sentence", () => {
    expect(SOCIAL.length).toBeGreaterThan(1_000);
  });

  test("a refused computer action records the rule's name beside the rule", async () => {
    await expect(
      gateway.navigate(
        botSeat(BOT),
        { id: ADMIN.id },
        "https://www.facebook.com/",
      ),
    ).rejects.toThrow(ActionRefusedError);

    const [row, ...more] = (await refusals("computer.action_refused")).filter(
      (one) => decisionOf(one).rule === SOCIAL,
    );
    expect(more).toHaveLength(0);
    expect(decisionOf(row as { payload: unknown })).toMatchObject({
      allowed: false,
      rule: SOCIAL,
      ruleName: SOCIAL_NAME,
    });
  });

  test("a refused app call records the rule's name beside the rule", async () => {
    await expect(
      plugins.callTool({
        ref: `${APP}/update_record`,
        args: {},
        botId: BOT,
        actorId: ADMIN.id,
      }),
    ).rejects.toThrow(PluginRefusedError);

    const rows = await refusals("mcp.call_rejected");
    expect(rows).toHaveLength(1);
    expect(decisionOf(rows[0] as { payload: unknown })).toMatchObject({
      allowed: false,
      rule: CRM_WRITES,
      ruleName: CRM_NAME,
    });
  });

  test("a rule nobody named is recorded by its expression alone", async () => {
    await expect(
      gateway.navigate(
        botSeat(BOT),
        { id: ADMIN.id },
        "https://unnamed.example/",
      ),
    ).rejects.toThrow(ActionRefusedError);

    const [row] = (await refusals("computer.action_refused")).filter(
      (one) => decisionOf(one).rule === UNNAMED,
    );
    const decision = decisionOf(row as { payload: unknown });
    expect(decision.rule).toBe(UNNAMED);
    expect(decision).not.toHaveProperty("ruleName");
  });
});
