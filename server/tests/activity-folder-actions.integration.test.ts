import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditReader, createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  createHostAccessBroker,
  type HostAccessBroker,
} from "../src/host-access/broker";
import { hostAccessTools } from "../src/host-access/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What a Bot's folder actions on the person's own computer leave on the trail.
 *
 * Seen on Windows with folder access on (OpenBot Desktop, personal edition): every folder call a Bot
 * made, reading a file, a write the person denied, a command, showed in Settings > Activity as
 * "Change a setting / Configuration changed / Started by a person". The denied write was not under
 * Blocked and none were under Computer actions, because each was written as `configuration.changed`.
 * These drive the Bot's real tools against the real broker and read the rows back through the reader
 * Activity's views use, against a real database.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const reader = createAuditReader(database);
const suite = randomUUID().slice(0, 8);
const BOT = `folders-bot-${suite}`;
const PERSON = `folders-person-${suite}`;
const GRANT = `grant-${suite}`;

/** The views' own filters: `@/lib/audit/outcome` in the app. */
const COMPUTER_ACTIONS =
  "computer.action_allowed,computer.action_refused,computer.action_failed,computer.action_stopped";
const BLOCKED = "computer.action_refused";

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: PERSON, email: `${PERSON}@example.test` });
});

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

function connectedBroker(): HostAccessBroker {
  const broker = createHostAccessBroker();
  broker.rememberGrant({
    id: GRANT,
    botId: BOT,
    actorId: PERSON,
    displayName: "Notes",
    revoked: false,
  });
  broker.nextDesktopOperation();
  return broker;
}

/** What the desktop's worker does: wait for the server to hand it the operation, then answer it. */
async function desktopAnswers(
  broker: HostAccessBroker,
  answer: { ok: true; result: unknown } | { ok: false; error: string },
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const operation = broker.nextDesktopOperation()?.operations[0];
    if (operation) {
      broker.resolveDesktopOperation({
        operationId: operation.operationId,
        ...answer,
      });
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the desktop was never handed an operation");
}

async function run(
  broker: HostAccessBroker,
  name: string,
  args: Record<string, unknown>,
  answer: { ok: true; result: unknown } | { ok: false; error: string },
) {
  const tool = hostAccessTools({
    broker,
    botId: BOT,
    actorId: PERSON,
    auditStore,
    initiator: { kind: "person" },
  }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} is not offered`);
  const text = tool.execute(args);
  await desktopAnswers(broker, answer);
  return text;
}

/** This Bot's rows in a view, oldest first, as the reader returns them. */
async function rows(eventType: string) {
  const { events } = await reader.list({ limit: 50, bot: BOT, eventType });
  return events.reverse().map((event) => ({
    eventType: event.eventType,
    initiatorKind: event.initiatorKind,
    action: event.payload.action,
    bot: event.payload.bot,
    file: event.payload.file,
    folder: event.payload.folder,
    command: event.payload.command,
    refusal: event.payload.refusal,
    attempt: typeof event.payload.attempt === "string",
  }));
}

/** Rows compared as a set. */
function inAnyOrder<T>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

describe("a Bot's folder actions", () => {
  test("are computer actions, a person's Deny is under Blocked, and nothing is a setting", async () => {
    const broker = connectedBroker();
    await run(
      broker,
      "host_read_file",
      { grantId: GRANT, path: "todo.txt" },
      { ok: true, result: { content: "buy milk" } },
    );
    const denied = await run(
      broker,
      "host_write_file",
      { grantId: GRANT, path: "todo.txt", content: "do not log" },
      { ok: false, error: "The local owner denied this operation." },
    );
    expect(denied).toContain("denied");
    await run(
      broker,
      "host_run_command",
      { grantId: GRANT, command: "dir" },
      { ok: true, result: { stdout: "todo.txt" } },
    );

    const read = {
      eventType: "computer.action_allowed",
      initiatorKind: "person",
      action: "host/read_file",
      bot: BOT,
      file: "todo.txt",
      // The folder by its name, never only the grant's id (seen on the Mac: "host-grant-…").
      folder: "Notes",
      command: undefined,
      refusal: undefined,
      attempt: true,
    };
    const write = {
      ...read,
      action: "host/write_file",
    };
    const refusedWrite = {
      ...write,
      eventType: "computer.action_refused",
      refusal: "person_declined",
    };
    const command = {
      ...read,
      action: "host/run_command",
      file: undefined,
      command: "dir",
    };
    // As a set: rows written in the same millisecond come back in either order (the reader breaks a
    // tie on a random id), and CI's runner was fast enough to write two of them in one.
    expect(inAnyOrder(await rows(COMPUTER_ACTIONS))).toEqual(
      inAnyOrder([read, write, refusedWrite, command]),
    );
    expect(await rows(BLOCKED)).toEqual([refusedWrite]);
    expect(await rows("configuration.changed")).toEqual([]);

    // The file's name and the command, never what was written.
    const { events } = await reader.list({ limit: 50, bot: BOT });
    expect(JSON.stringify(events)).not.toContain("do not log");
  });
});
