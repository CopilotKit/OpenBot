import { afterAll, expect, test } from "bun:test";
import {
  auditEventsToCsv,
  auditQueryFromUrl,
  createAuditReader,
  createAuditStore,
  readAuditExportRows,
} from "../src/audit";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createAuditStore(database);
const reader = createAuditReader(database);

afterAll(async () => {
  await database.$client.close();
});

/**
 * One Bot's rows, asked of the server: the Bot's own Activity page links to the trail narrowed to it.
 *
 * Its rows are the two kinds the audit page's Bot column reads: what the Bot did, which names it in
 * the payload whatever the target is (a file on its computer, an app's tool, an approval), and what
 * was done to it, which targets it. Narrowed in the browser instead, a Bot whose actions were older
 * than the newest page showed none at all.
 */
test("the trail narrowed to one Bot holds its actions and what was done to it, and no other Bot's", async () => {
  // Nothing is cleaned up: the retention trigger refuses the delete, so this run takes its own ids.
  const bot = `bot-filter-${crypto.randomUUID()}`;
  const other = `bot-filter-other-${crypto.randomUUID()}`;
  await store.insert({
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: bot,
    payload: { bot, action: "computer_write_file", file: "refused.txt" },
  });
  await store.insert({
    eventType: "approval.person_decided",
    targetType: "approval",
    targetId: crypto.randomUUID(),
    payload: { bot, decision: "deny", tool: "computer_write_file" },
  });
  await store.insert({
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: "hubspot/search",
    payload: { bot },
  });
  await store.insert({
    eventType: "bot.paused",
    targetType: "agent",
    targetId: bot,
    payload: {},
  });
  await store.insert({
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: other,
    payload: { bot: other, action: "computer_read_file" },
  });

  const query = auditQueryFromUrl(
    new URL(`https://openbot.test/audit?bot=${encodeURIComponent(bot)}`),
  );
  const { events } = await reader.list(query);
  expect(events.map((event) => event.eventType).sort()).toEqual([
    "approval.person_decided",
    "bot.paused",
    "computer.action_refused",
    "mcp.call_succeeded",
  ]);

  // Beside a saved view's types, it narrows that view.
  const refused = await reader.list(
    auditQueryFromUrl(
      new URL(
        `https://openbot.test/audit?eventType=computer.action_refused,computer.action_allowed&bot=${encodeURIComponent(bot)}`,
      ),
    ),
  );
  expect(refused.events.map((event) => event.eventType)).toEqual([
    "computer.action_refused",
  ]);

  // And the file a person downloads from that view is the same rows.
  const exported = await readAuditExportRows(reader, query);
  expect(exported.events).toHaveLength(4);
  expect(auditEventsToCsv(exported.events)).not.toContain(other);
});
