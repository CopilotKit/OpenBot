import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ExchangeResponse,
  LEARNING_SPACE_STATES,
  RECORDER_SIGNED_OUT,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const busy = `${prefix}-busy`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const INSTALL = "c".repeat(32);
const OTHER_EXTENSION = `chrome-extension://${"a".repeat(32)}`;

let transcribed = 0;
const transcriber = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    transcribed += 1;
    return Response.json({ text: "hello from the fake" });
  },
});

type Harness = ReturnType<typeof build>;

function build(extra: Record<string, string | undefined> = {}) {
  const config = loadConfig(
    testEnvironment({
      TRANSCRIPTION_PROVIDER: "openai-compatible",
      TRANSCRIPTION_BASE_URL: `http://127.0.0.1:${transcriber.port}`,
      TRANSCRIPTION_MODEL: "fake",
      ...extra,
    }),
  );
  const audits: AuditEventInput[] = [];
  const auditStore = {
    insert: async (event: AuditEventInput) => {
      audits.push(event);
    },
  };
  const roleRepository = { rolesForUser: async () => ["user" as const] };
  const bot = (id: string, hidden = false) => ({
    id,
    name: `Bot ${id}`,
    hidden,
    deletedAt: null,
  });
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    agentProfileStore: {
      list: async () => [bot("mine"), bot("hidden", true), bot("foreign")],
      get: async (_actor: unknown, id: string) =>
        id === "mine" ? bot("mine") : null,
    } as never,
    pluginStore: { agentOwner: async () => null },
    actorFor: async (id) => ({ id, role: "user" }),
    learningSettingsStore: { read: async () => ({}) as never },
    snapshots: { getLearnedSkillsSnapshot: async () => ({}) as never },
    auditStore,
  });
  const app = createApp(
    config,
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get("cookie") ?? "";
          const id = cookie.includes("test-session=owner")
            ? owner
            : cookie.includes("test-session=busy")
              ? busy
              : null;
          return id
            ? { user: { id, email: `${id}@example.test`, name: "The Owner" } }
            : null;
        },
      },
    } as never,
    roleRepository,
    ...(Array.from({ length: 9 }) as never[]),
    auditStore,
    ...(Array.from({ length: 21 }) as never[]),
    { recorder },
  );
  return { app, audits, config };
}

const call = (
  { app }: Harness,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) => {
  const { json, headers, ...rest } = init;
  return app.request(`http://openbot.test${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};
const COOKIE = { cookie: "test-session=owner" };

async function connect(
  harness: Harness,
  installId = INSTALL,
): Promise<ExchangeResponse> {
  const minted = await call(harness, "/api/recorder/connect-codes", {
    method: "POST",
    headers: COOKIE,
    json: { via: "web" },
  });
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call(harness, "/api/recorder/connections", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { code, label: "Chrome on macOS", installId },
  });
  expect(exchanged.status).toBe(201);
  return exchanged.json();
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "The Owner" },
    { id: busy, email: `${busy}@example.test`, name: "The Owner" },
  ]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, busy]));
  await database.$client.close();
  await transcriber.stop(true);
});

describe("connecting", () => {
  test("a connect code needs JSON and a signed-in person", async () => {
    const h = build();
    const form = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: { ...COOKIE, "content-type": "text/plain" },
      body: '{"via":"web"}',
    });
    expect(form.status).toBe(415);
    const anonymous = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      json: { via: "web" },
    });
    expect(anonymous.status).toBe(401);
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web" },
    });
    expect(minted.status).toBe(201);
    expect(((await minted.json()) as { code: string }).code).toMatch(/^obc_/);
  });

  test("a person who already holds ten unused codes is told to wait", async () => {
    const h = build();
    const mint = () =>
      call(h, "/api/recorder/connect-codes", {
        method: "POST",
        headers: { cookie: "test-session=busy" },
        json: { via: "web" },
      });
    for (let index = 0; index < 10; index += 1) {
      expect((await mint()).status).toBe(201);
    }
    const refused = await mint();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error:
        "Too many connection codes were asked for at once. Wait a few minutes and try again.",
    });
  });

  test("a body over 2 KiB is refused", async () => {
    const h = build();
    const big = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web", padding: "x".repeat(3000) },
    });
    expect(big.status).toBe(413);
  });

  test("only the Recorder's own origin may finish connecting", async () => {
    const h = build();
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "web" },
    });
    const { code } = (await minted.json()) as { code: string };
    const body = { code, label: "x", installId: INSTALL };
    for (const origin of ["https://evil.example.test", OTHER_EXTENSION]) {
      const refused = await call(h, "/api/recorder/connections", {
        method: "POST",
        headers: { origin },
        json: body,
      });
      expect(refused.status).toBe(403);
    }
    expect(
      h.audits.filter((a) => a.eventType === "recorder.connect_refused"),
    ).toHaveLength(2);
    const missing = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: { code, label: "x" },
    });
    expect(missing.status).toBe(400);
    const done = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: body,
    });
    expect(done.status).toBe(201);
    const made = (await done.json()) as ExchangeResponse;
    expect(made.connection.installId).toBe(INSTALL);
    expect(made.user.id).toBe(owner);
    expect(
      h.audits.filter((a) => a.eventType === "recorder.connected"),
    ).toHaveLength(1);
    const again = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: ORIGIN },
      json: body,
    });
    expect(again.status).toBe(400);
  });

  test("the same copy connecting again replaces its older connection", async () => {
    const h = build();
    const first = await connect(h, "d".repeat(32));
    const second = await connect(h, "d".repeat(32));
    const replaced = h.audits.filter((a) => a.eventType === "recorder.revoked");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.payload).toEqual({
      connectionId: first.connection.id,
      reason: "replaced",
    });
    expect(
      (await call(h, "/api/recorder/me", { headers: bearer(first.token) }))
        .status,
    ).toBe(401);
    expect(
      (await call(h, "/api/recorder/me", { headers: bearer(second.token) }))
        .status,
    ).toBe(200);
  });

  test("extra extension ids are listed after the fixed one and accepted", async () => {
    const extra = "b".repeat(32);
    const plain = build();
    const refused = await call(plain, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: `chrome-extension://${extra}` },
      json: { code: "obc_x", label: "x", installId: INSTALL },
    });
    expect(refused.status).toBe(403);
    const h = build({ OPENBOT_RECORDER_EXTRA_EXTENSION_IDS: extra });
    const listed = await call(h, "/api/recorder/connections", {
      headers: COOKIE,
    });
    expect(
      ((await listed.json()) as { extensionIds: string[] }).extensionIds,
    ).toEqual([RECORDER_EXTENSION_ID, extra]);
    const minted = await call(h, "/api/recorder/connect-codes", {
      method: "POST",
      headers: COOKIE,
      json: { via: "desktop" },
    });
    const { code } = (await minted.json()) as { code: string };
    const accepted = await call(h, "/api/recorder/connections", {
      method: "POST",
      headers: { origin: `chrome-extension://${extra}/` },
      json: { code, label: "Fork", installId: "f".repeat(32) },
    });
    expect(accepted.status).toBe(201);
  });
});

describe("using the bearer", () => {
  test("me, bots and the connections list", async () => {
    const h = build();
    const made = await connect(h, "1".repeat(32));
    const me = await call(h, "/api/recorder/me", {
      headers: bearer(made.token),
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: owner, email: `${owner}@example.test`, name: "The Owner" },
      connectionId: made.connection.id,
    });

    const bots = (await (
      await call(h, "/api/recorder/bots", { headers: bearer(made.token) })
    ).json()) as {
      bots: {
        id: string;
        learning: { state: string; containerId: string | null };
      }[];
    };
    expect(bots.bots.map((b) => b.id)).toEqual(["mine"]);
    for (const bot of bots.bots) {
      expect(LEARNING_SPACE_STATES as readonly string[]).toContain(
        bot.learning.state,
      );
      expect(
        bot.learning.containerId === null ||
          typeof bot.learning.containerId === "string",
      ).toBe(true);
    }

    const listed = (await (
      await call(h, "/api/recorder/connections", { headers: COOKIE })
    ).json()) as {
      connections: { id: string }[];
      extensionIds: string[];
    };
    expect(listed.connections.map((c) => c.id)).toContain(made.connection.id);
    expect(listed.extensionIds).toEqual([RECORDER_EXTENSION_ID]);
  });

  test("disconnecting signs the browser out", async () => {
    const h = build();
    const made = await connect(h, "3".repeat(32));
    const gone = await call(h, "/api/recorder/connections/current", {
      method: "DELETE",
      headers: bearer(made.token),
    });
    expect(gone.status).toBe(204);
    expect(
      h.audits.find((a) => a.eventType === "recorder.revoked")?.payload,
    ).toMatchObject({ connectionId: made.connection.id });
    const after = await call(h, "/api/recorder/me", {
      headers: bearer(made.token),
    });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { code: string }).code).toBe(
      RECORDER_SIGNED_OUT,
    );
    expect(
      h.audits.filter((a) => a.eventType === "recorder.bearer_refused"),
    ).toHaveLength(1);
  });

  test("a person removes one of their connections from the list", async () => {
    const h = build();
    const made = await connect(h, "4".repeat(32));
    const removed = await call(
      h,
      `/api/recorder/connections/${made.connection.id}`,
      { method: "DELETE", headers: COOKIE },
    );
    expect(removed.status).toBe(204);
    const missing = await call(h, "/api/recorder/connections/nope", {
      method: "DELETE",
      headers: COOKIE,
    });
    expect(missing.status).toBe(404);
    expect(
      (await call(h, "/api/recorder/me", { headers: bearer(made.token) }))
        .status,
    ).toBe(401);
  });

  test("the bearer cannot transcribe speech, even with the dictation header", async () => {
    const h = build();
    const made = await connect(h, "5".repeat(32));
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(8)], "recording.webm", { type: "audio/webm" }),
    );
    const answer = await h.app.request(
      "http://openbot.test/api/audio/transcriptions",
      {
        method: "POST",
        headers: { ...bearer(made.token), "x-openbot-dictation": "1" },
        body: form,
      },
    );
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: "Authentication required." });
    expect(transcribed).toBe(0);
  });

  test("OpenBot takes no recording from the Recorder, not even with its bearer", async () => {
    const h = build();
    const made = await connect(h, "6".repeat(32));
    for (const [method, path] of [
      ["POST", "/api/recorder/demonstrations"],
      ["GET", "/api/recorder/demonstrations/open?botId=mine"],
      ["POST", "/api/recorder/demonstrations/x/actions"],
      ["POST", "/api/recorder/demonstrations/x/media"],
      ["PUT", "/api/recorder/demonstrations/x/media/m/chunks/0"],
    ]) {
      const answer = await call(h, path, {
        method,
        headers: bearer(made.token),
        ...(method === "GET" ? {} : { json: {} }),
      });
      expect([method, path, answer.status]).toEqual([method, path, 404]);
    }
  });
});
