import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  auditQueryFromUrl,
  createAuditReader,
  createAuditStore,
  recordAuditEvent,
} from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createHostAccessBroker } from "../src/host-access/broker";
import { createHostAccessRoutes } from "../src/host-access/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Two rows Settings > Activity showed in the personal edition that a person could not read.
 *
 * "Choose tools for a run / 96 of 96 tools / Couldn't choose, so all were offered" on every turn,
 * which is OpenBot's own working: the page now asks the server to leave it out, and Admin, which
 * asks without that, keeps it. And choosing a folder for a Bot read "Change a setting", with no Bot
 * and no folder, because the row named the Bot as `botId` and the folder not at all.
 *
 * Through the real folder routes, the real broker answered as the desktop answers it over HTTP, and
 * the reader Activity's views use, on a real database.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const reader = createAuditReader(database);
const suite = randomUUID().slice(0, 8);
const PERSON = `plumbing-person-${suite}`;
const BOT = `plumbing-bot-${suite}`;
const OTHER_BOT = `plumbing-other-${suite}`;
const TOKEN = "desktop-token";

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: PERSON, email: `${PERSON}@example.test` });
});

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

/** The folder routes as `app.ts` mounts them, for one person who may use both Bots. */
function folderApp() {
  const broker = createHostAccessBroker();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/host-access",
    createHostAccessRoutes({
      broker,
      desktopToken: TOKEN,
      auditStore,
      requireUser: async (context, next) => {
        context.set("actor", {
          id: PERSON,
          email: `${PERSON}@example.test`,
          role: "admin",
        });
        await next();
      },
      canUseBot: async (_actor, botId) => botId === BOT || botId === OTHER_BOT,
      botName: async () => "Personal Assistant",
    }),
  );
  return app;
}

const desktop = { authorization: `Bearer ${TOKEN}` };

/** What the desktop's worker does: poll, then answer the folder chooser with the folder picked. */
async function desktopPicks(
  app: Hono<{ Variables: AppVariables }>,
  folder: string,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { operations } = (await (
      await app.request("/api/host-access/desktop/next", { headers: desktop })
    ).json()) as { operations: { operationId: string; kind: string }[] };
    const choose = operations.find(
      (operation) => operation.kind === "choose_folder",
    );
    if (choose) {
      await app.request("/api/host-access/desktop/result", {
        method: "POST",
        headers: { ...desktop, "content-type": "application/json" },
        body: JSON.stringify({
          operationId: choose.operationId,
          ok: true,
          grant: { grantId: `grant-${folder}-${suite}`, displayName: folder },
        }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the desktop was never asked to choose a folder");
}

/** Choose folder, on Settings > Computer, for one Bot. */
async function chooseFolder(
  app: Hono<{ Variables: AppVariables }>,
  botId: string,
  folder: string,
) {
  // The desktop is online before the person presses the button.
  await app.request("/api/host-access/desktop/next", { headers: desktop });
  const pressed = app.request("/api/host-access/grants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId }),
  });
  await desktopPicks(app, folder);
  const response = await pressed;
  expect(response.status).toBe(200);
  return ((await response.json()) as { grant: { id: string } }).grant.id;
}

/**
 * The person's folder rows, oldest first, as the reader returns them, with only the fields each
 * row holds: a row with no folder has no `folder` key, so the expected rows below name what is
 * there and nothing that is not.
 */
async function folderRows(bot?: string) {
  const { events } = await reader.list({
    limit: 50,
    actorUserId: PERSON,
    targetType: "host_access",
    ...(bot ? { bot } : {}),
  });
  return events.reverse().map((event) =>
    Object.fromEntries(
      Object.entries({
        change: event.payload.change,
        bot: event.payload.bot,
        folder: event.payload.folder,
        folders: event.payload.folders,
        initiatorKind: event.initiatorKind,
      }).filter(([, value]) => value !== undefined),
    ),
  );
}

describe("a person's folders for a Bot", () => {
  test("say which Bot and which folder, given, taken away and stopped", async () => {
    const app = folderApp();
    const share = await chooseFolder(app, BOT, "share");
    await chooseFolder(app, OTHER_BOT, "Documents");
    expect(
      (
        await app.request(`/api/host-access/grants/${share}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect(
      (await app.request("/api/host-access/stop", { method: "POST" })).status,
    ).toBe(200);

    expect(await folderRows()).toEqual([
      {
        change: "host_folder_granted",
        bot: BOT,
        folder: "share",
        initiatorKind: "person",
      },
      {
        change: "host_folder_granted",
        bot: OTHER_BOT,
        folder: "Documents",
        initiatorKind: "person",
      },
      {
        change: "host_folder_revoked",
        bot: BOT,
        folder: "share",
        initiatorKind: "person",
      },
      // Only Documents was still open, so stopping ended it, for its one Bot.
      {
        change: "host_access_stopped",
        bot: OTHER_BOT,
        folders: ["Documents"],
        initiatorKind: "person",
      },
    ]);

    // A Bot's own Activity finds its folder rows.
    expect((await folderRows(BOT)).map((row) => row.change)).toEqual([
      "host_folder_granted",
      "host_folder_revoked",
    ]);
  });

  test("a folder row written before named the Bot as botId, and is still that Bot's row", async () => {
    const bot = `plumbing-older-${suite}`;
    await recordAuditEvent(auditStore, {
      eventType: "configuration.changed",
      targetType: "host_access",
      targetId: `grant-older-${suite}`,
      actorUserId: PERSON,
      payload: {
        actorUserId: PERSON,
        targetId: `grant-older-${suite}`,
        change: "host_folder_granted",
        botId: bot,
      },
    });
    const { events } = await reader.list({ limit: 50, bot });
    expect(events.map((event) => event.payload.change)).toEqual([
      "host_folder_granted",
    ]);
  });
});

describe("choosing tools for a run", () => {
  const bot = `plumbing-tools-${suite}`;

  beforeAll(async () => {
    // A turn as the server records it: the tools it was offered, then what the Bot did.
    await recordAuditEvent(auditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: bot,
      actorUserId: PERSON,
      payload: {
        bot,
        reason: "unavailable",
        granted: 96,
        offered: 96,
        skills: [],
      },
    });
    await recordAuditEvent(auditStore, {
      eventType: "computer.action_allowed",
      targetType: "computer",
      targetId: bot,
      actorUserId: PERSON,
      payload: { bot, action: "computer_read_file", file: "todo.txt" },
    });
  });

  /** One Bot's rows for a query the page sends, as the route reads it. */
  async function typesFor(search: string) {
    const url = new URL(`http://127.0.0.1/api/admin/audit-events${search}`);
    url.searchParams.set("bot", bot);
    const { events } = await reader.list(auditQueryFromUrl(url));
    return events.map((event) => event.eventType).sort();
  }

  test("are left out of what Activity asks for, in every view", async () => {
    const leaveOut = "excludeEventType=mcp.tools_discovered";
    expect(await typesFor(`?${leaveOut}`)).toEqual(["computer.action_allowed"]);
    expect(
      await typesFor(
        `?eventType=computer.action_allowed,mcp.tools_discovered&${leaveOut}`,
      ),
    ).toEqual(["computer.action_allowed"]);
  });

  test("stay in what Admin asks for", async () => {
    expect(await typesFor("")).toEqual([
      "computer.action_allowed",
      "mcp.tools_discovered",
    ]);
  });
});
