import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appKey } from "@openbot/shared/audit-filters";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { appKeySql } from "../src/audit-filters";
import {
  type AuditEvent,
  type AuditEventInput,
  auditQueryFromUrl,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { intentOf } from "../src/computer/gateway";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The trail's payload filters, asked of PostgreSQL: which app, which tool, read or write, what an
 * action did, and which boundary rule refused it.
 *
 * Over rows shaped exactly as `callTool` (`plugins/plugin-store/calls.ts`), the computer gateway
 * (`computer/gateway.ts`) and the folder tools (`host-access/tools.ts`) write them, through the real
 * reader and the real `GET /api/admin/audit-events`, JSON and CSV.
 *
 * Nothing is cleaned up: the retention trigger refuses the delete. So each run takes its own Bot ids
 * and every query is narrowed to them, or checks only for this run's rows.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAuditStore(database);
const reader = createAuditReader(database);

afterAll(async () => {
  await database.$client.close();
});

const run = crypto.randomUUID().slice(0, 8);
const RESEARCH = `bot-research-${run}`;
const SALES = `bot-sales-${run}`;
const DANA = `user-dana-${run}`;
const SOCIAL_RULE =
  'intent == "navigate" && page.host in ["facebook.com", "x.com"]';
const SALESFORCE_RULE =
  'mcp.effect == "write" && contains(mcp.server, "salesforce")';

/** An app call's row, as `callTool` writes it once the boundary has decided. */
function appCall(input: {
  bot: string;
  server: string;
  tool: string;
  effect: "read" | "write";
  outcome: "succeeded" | "failed" | "rejected";
  rule?: string;
  initiator?: AuditEventInput["initiator"];
}): AuditEventInput {
  const allowed = input.outcome !== "rejected";
  return {
    eventType: `mcp.call_${input.outcome}`,
    targetType: "mcp_tool",
    targetId: `${input.server}/${input.tool}`,
    ...(input.initiator ? { initiator: input.initiator } : {}),
    payload: {
      actor: DANA,
      bot: input.bot,
      server: input.server,
      tool: input.tool,
      effect: input.effect,
      attempt: crypto.randomUUID(),
      reachedAs: DANA,
      decision: {
        allowed,
        mode: "enforce",
        rule: allowed ? "true" : (input.rule ?? null),
        source: allowed ? "allow" : input.rule ? "deny" : "default",
        carriedOut: allowed,
      },
      ...(input.outcome === "failed"
        ? { failure: "The caller does not have permission" }
        : {}),
    },
  };
}

/** A computer action's row, as the gateway writes it. */
function computerAction(input: {
  bot: string;
  action: string;
  key?: string;
  refusedBy?: string;
  page?: string;
  command?: string;
}): AuditEventInput {
  const allowed = input.refusedBy === undefined;
  return {
    eventType: allowed ? "computer.action_allowed" : "computer.action_refused",
    targetType: "computer",
    targetId: input.bot,
    actorUserId: DANA,
    payload: {
      action: input.action,
      bot: input.bot,
      computer: `person:${DANA}`,
      actor: DANA,
      page: input.page ?? "https://www.example.com/",
      ref: null,
      ...(input.key ? { key: input.key } : {}),
      ...(input.command ? { command: input.command } : {}),
      decision: {
        allowed,
        mode: "enforce",
        source: allowed ? "allow" : "deny",
        rule: allowed ? "true" : input.refusedBy,
        carriedOut: allowed,
      },
    },
  };
}

/** A folder action on the person's own computer, as `host-access/tools.ts` writes it. */
function folderAction(bot: string, operation: string): AuditEventInput {
  return {
    eventType: "computer.action_allowed",
    targetType: "host_access",
    targetId: crypto.randomUUID(),
    actorUserId: DANA,
    payload: {
      action: `host/${operation}`,
      bot,
      actor: DANA,
      folder: "Reports",
      ...(operation === "run_command"
        ? { command: "ls -la" }
        : { file: "q3.csv" }),
    },
  };
}

/** Keys as the gateway records them on a keypress, the tricky ones included. */
const KEYS = [
  "Enter",
  "NumpadEnter",
  "Space",
  "a",
  "Shift+Enter",
  "Control+Enter",
  "Shift+Space",
  "Shift++",
  "Control+Shift+Enter",
  "Tab",
  "Escape",
  "+Enter",
  "++Enter",
  "a++Enter",
  "Shift+++Enter",
];

const ROWS: AuditEventInput[] = [
  // The research Bot: Gmail through two brokers, a Salesforce write refused by a rule, Drive reads.
  appCall({
    bot: RESEARCH,
    server: "composio-gmail",
    tool: "GMAIL_SEND_EMAIL",
    effect: "write",
    outcome: "succeeded",
    initiator: { kind: "routine", id: `routine-${run}` },
  }),
  appCall({
    bot: RESEARCH,
    server: "arcade-Gmail",
    tool: "Gmail_ListEmails",
    effect: "read",
    outcome: "succeeded",
  }),
  appCall({
    bot: RESEARCH,
    server: "composio-gmail",
    tool: "GMAIL_FETCH_EMAILS",
    effect: "read",
    outcome: "failed",
  }),
  appCall({
    bot: RESEARCH,
    server: "composio-salesforce",
    tool: "SALESFORCE_UPDATE_RECORD",
    effect: "write",
    outcome: "rejected",
    rule: SALESFORCE_RULE,
  }),
  appCall({
    bot: RESEARCH,
    server: "composio-googledrive",
    tool: "GOOGLEDRIVE_FIND_FILE",
    effect: "read",
    outcome: "succeeded",
  }),
  // The sales Bot: a Salesforce read, and Facebook refused by the social media rule.
  appCall({
    bot: SALES,
    server: "composio-salesforce",
    tool: "SALESFORCE_QUERY",
    effect: "read",
    outcome: "succeeded",
  }),
  computerAction({
    bot: SALES,
    action: "computer_navigate",
    page: "https://facebook.com/",
    refusedBy: SOCIAL_RULE,
  }),
  computerAction({ bot: SALES, action: "computer_navigate" }),
  computerAction({
    bot: SALES,
    action: "computer_run_command",
    command: "rm -rf build",
  }),
  computerAction({ bot: SALES, action: "computer_click" }),
  computerAction({ bot: SALES, action: "computer_scroll" }),
  computerAction({ bot: SALES, action: "computer_type" }),
  computerAction({ bot: SALES, action: "computer_type", key: "Enter" }),
  computerAction({ bot: SALES, action: "computer_write_file" }),
  folderAction(SALES, "run_command"),
  folderAction(SALES, "read_file"),
  ...KEYS.map((key) =>
    computerAction({ bot: SALES, action: "computer_key", key }),
  ),
  // Rows that carry the keys a careless filter would read, and are not app calls.
  {
    eventType: "approval.evaluated",
    targetType: "approval",
    targetId: "composio-gmail/GMAIL_SEND_EMAIL",
    payload: {
      decidedBy: "policy",
      bot: RESEARCH,
      tool: "composio-gmail/GMAIL_SEND_EMAIL",
      effect: "write",
      scope: "composio-gmail",
      outcome: { behaviour: "ask" },
    },
  },
  {
    eventType: "credential.created",
    targetType: "credential",
    payload: { bot: RESEARCH, server: "composio-gmail" },
  },
];

let start = "";

beforeAll(async () => {
  start = new Date(Date.now() - 1000).toISOString();
  for (const row of ROWS) await store.insert(row);
});

async function list(search: string, limit = 100): Promise<AuditEvent[]> {
  const url = new URL(
    `https://openbot.test/api/admin/audit-events?limit=${limit}&from=${encodeURIComponent(start)}&${search}`,
  );
  return (await reader.list(auditQueryFromUrl(url))).events;
}

const tools = (events: AuditEvent[]) =>
  events.map((event) => String(event.payload.tool)).sort();
const actions = (events: AuditEvent[]) =>
  events.map((event) => String(event.payload.action)).sort();

describe("app, tool and effect, on app calls", () => {
  test("an app is every call to it, whichever broker carried it, and nothing else", async () => {
    const gmail = await list(`bot=${RESEARCH}&app=gmail`);
    expect(gmail.map((event) => event.eventType).sort()).toEqual([
      "mcp.call_failed",
      "mcp.call_succeeded",
      "mcp.call_succeeded",
    ]);
    expect(tools(gmail)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "Gmail_ListEmails",
    ]);

    // Named by its server, by another broker's, or in another case, it is the same app.
    for (const name of ["composio-gmail", "arcade-gmail", "Gmail"])
      expect(tools(await list(`bot=${RESEARCH}&app=${name}`))).toEqual(
        tools(gmail),
      );
    expect(tools(await list(`bot=${RESEARCH}&app=google-drive`))).toEqual([
      "GOOGLEDRIVE_FIND_FILE",
    ]);
  });

  test("several apps are any of them, and an app with no calls matches nothing", async () => {
    expect(tools(await list(`app=salesforce,googledrive`))).toEqual(
      expect.arrayContaining([
        "GOOGLEDRIVE_FIND_FILE",
        "SALESFORCE_QUERY",
        "SALESFORCE_UPDATE_RECORD",
      ]),
    );
    const both = await list(`app=salesforce,googledrive`);
    expect(
      both.some((event) => String(event.payload.server).includes("gmail")),
    ).toBe(false);
    expect(await list(`bot=${RESEARCH}&app=notion`)).toEqual([]);
  });

  test("a tool is matched in any case, and effect separates reads from changes", async () => {
    expect(tools(await list(`bot=${RESEARCH}&tool=gmail_send_email`))).toEqual([
      "GMAIL_SEND_EMAIL",
    ]);
    expect(
      tools(
        await list(
          `bot=${RESEARCH}&tool=GMAIL_SEND_EMAIL,SALESFORCE_UPDATE_RECORD`,
        ),
      ),
    ).toEqual(["GMAIL_SEND_EMAIL", "SALESFORCE_UPDATE_RECORD"]);
    expect(tools(await list(`bot=${RESEARCH}&app=gmail&effect=write`))).toEqual(
      ["GMAIL_SEND_EMAIL"],
    );
    expect(tools(await list(`bot=${RESEARCH}&effect=read`))).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GOOGLEDRIVE_FIND_FILE",
      "Gmail_ListEmails",
    ]);
  });

  test("an approval or a credential naming the same app is not an app call", async () => {
    const rows = await list(`bot=${RESEARCH}&app=gmail&effect=write`);
    expect(rows.map((event) => event.eventType)).toEqual([
      "mcp.call_succeeded",
    ]);
  });

  test("beside the filters there before, they narrow together: a routine's Gmail changes", async () => {
    const rows = await list(
      `app=gmail&effect=write&initiatorKind=routine&bot=${RESEARCH}`,
    );
    expect(tools(rows)).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(rows[0]?.initiatorId).toBe(`routine-${run}`);
  });

  test("several Bots, separated by commas, are each Bot's rows, as the Bot chip asks for them", async () => {
    expect(
      tools(await list(`bot=${RESEARCH},${SALES}&app=salesforce`)),
    ).toEqual(["SALESFORCE_QUERY", "SALESFORCE_UPDATE_RECORD"]);
    expect(tools(await list(`bot=${SALES}&app=salesforce`))).toEqual([
      "SALESFORCE_QUERY",
    ]);
  });

  test("the person filter finds the app calls made with their accounts, which name them only in the payload", async () => {
    const rows = await list(`actorUserId=${DANA}&bot=${RESEARCH}`);
    expect(
      rows.filter((event) => event.eventType.startsWith("mcp.call")),
    ).toHaveLength(5);
  });
});

describe("intent, on computer actions", () => {
  test("each action is read as the intent the gateway gave it", async () => {
    const intents = [
      "activate",
      "type",
      "navigate",
      "read",
      "write_file",
      "run_command",
      "read_file",
    ] as const;
    const found = new Map<string, string[]>();
    for (const intent of intents) {
      for (const event of await list(`bot=${SALES}&intent=${intent}`)) {
        const id = `${event.payload.action}|${event.payload.key ?? ""}`;
        found.set(id, [...(found.get(id) ?? []), intent]);
      }
    }
    // Every computer action this run wrote, in exactly the one intent `intentOf` gives it.
    for (const row of ROWS) {
      const payload = row.payload as {
        action?: string;
        key?: string;
        bot?: string;
      };
      if (payload.bot !== SALES || typeof payload.action !== "string") continue;
      if (row.eventType.startsWith("mcp.")) continue;
      const id = `${payload.action}|${payload.key ?? ""}`;
      const expected = payload.action.startsWith("host/")
        ? payload.action.slice("host/".length)
        : intentOf(payload.action, payload.key);
      // Two navigations share an id here; each was found under one intent, the same one.
      expect([id, [...new Set(found.get(id))]]).toEqual([
        id,
        [expected as string],
      ]);
    }
  });

  test("a command is a computer's and a folder's, and an app call's intent is its effect", async () => {
    expect(actions(await list(`bot=${SALES}&intent=run_command`))).toEqual([
      "computer_run_command",
      "host/run_command",
    ]);
    expect(tools(await list(`bot=${RESEARCH}&intent=write_tool`))).toEqual([
      "GMAIL_SEND_EMAIL",
      "SALESFORCE_UPDATE_RECORD",
    ]);
    expect(await list(`bot=${SALES}&intent=not_an_intent`)).toEqual([]);
  });
});

describe("rule, on refusals", () => {
  test("a rule is the refusals it made, its commas and quotes intact", async () => {
    const social = await list(`rule=${encodeURIComponent(SOCIAL_RULE)}`);
    expect(social.length).toBeGreaterThanOrEqual(1);
    expect(
      social.every((event) => event.eventType === "computer.action_refused"),
    ).toBe(true);
    expect(social.some((event) => event.payload.bot === SALES)).toBe(true);

    const salesforce = await list(
      `bot=${RESEARCH}&rule=${encodeURIComponent(SALESFORCE_RULE)}`,
    );
    expect(tools(salesforce)).toEqual(["SALESFORCE_UPDATE_RECORD"]);
    // `true` is the allow rule every allowed row names. It refused nothing.
    expect(await list(`bot=${RESEARCH}&rule=true`)).toEqual([]);
  });
});

describe("paging and export", () => {
  test("a filtered trail pages without repeating or losing a row", async () => {
    const all = await list(`bot=${SALES}&intent=type,activate`);
    expect(all.length).toBeGreaterThan(5);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const url = new URL(
        `https://openbot.test/api/admin/audit-events?limit=4&bot=${SALES}&intent=type,activate&from=${encodeURIComponent(start)}${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const page = await reader.list(auditQueryFromUrl(url));
      seen.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(Math.ceil(all.length / 4));
    expect(seen).toEqual(all.map((event) => event.id));
  });

  test("the JSON list and the CSV export from the route hold the same filtered rows", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      } as never,
      { rolesForUser: async () => ["admin"] } as never,
      reader,
    );
    const search = `bot=${RESEARCH}&app=gmail&effect=write&from=${encodeURIComponent(start)}`;
    const json = await app.request(
      `http://localhost:3001/api/admin/audit-events?${search}`,
    );
    expect(json.status).toBe(200);
    const listed = (await json.json()) as { events: AuditEvent[] };
    expect(tools(listed.events)).toEqual(["GMAIL_SEND_EMAIL"]);

    const csv = await app.request(
      `http://localhost:3001/api/admin/audit-events?format=csv&${search}`,
    );
    expect(csv.status).toBe(200);
    const lines = (await csv.text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(listed.events[0]?.id as string);
    expect(lines[1]).toContain("GMAIL_SEND_EMAIL");
  });
});

test("the app key in SQL is the app key in TypeScript, over the server names the trail holds", async () => {
  const servers = [
    "composio-gmail",
    "arcade-Gmail",
    "composio-googledrive",
    "google-drive",
    "google_drive",
    "arcade-GoogleDrive",
    "composio-salesforce",
    "notion",
    "hubspot",
    "parallel",
    "routines",
    "Composio-Slack",
    "arcade-",
  ];
  for (const server of servers) {
    const result = await database.execute(
      sql`select ${appKeySql(sql`${server}::text`)} as key`,
    );
    const key = (result as unknown as { key: string }[])[0]?.key;
    expect([server, key]).toEqual([server, appKey(server)]);
  }
});
