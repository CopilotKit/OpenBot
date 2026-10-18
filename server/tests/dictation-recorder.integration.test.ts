import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExchangeResponse } from "@openbot/shared/recorder-api";
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
const prefix = `dictation-recorder-${randomUUID()}`;
const owner = `${prefix}-owner`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const INSTALL = "c".repeat(32);

let release: () => void = () => {};
let reached: () => void = () => {};
let hold = false;
const transcriber = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async () => {
    if (hold) {
      reached();
      await new Promise<void>((resolve) => (release = resolve));
    }
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
    demonstrations: {} as never,
    auditStore,
  });
  const app = createApp(
    config,
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie")?.includes("test-session=owner")
            ? {
                user: {
                  id: owner,
                  email: `${owner}@example.test`,
                  name: "The Owner",
                },
              }
            : null,
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
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "The Owner" });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
  await database.$client.close();
  await transcriber.stop(true);
});

function slice(token?: string, header = true) {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(8)], "slice-0.webm", { type: "audio/webm" }),
  );
  return {
    method: "POST",
    headers: {
      ...(token ? bearer(token) : {}),
      ...(header ? { "x-openbot-dictation": "1" } : {}),
    },
    body: form,
  };
}
const transcribe = (h: Harness, init: ReturnType<typeof slice>) =>
  h.app.request("http://openbot.test/api/audio/transcriptions", init);

describe("the dictation route with the Recorder's bearer", () => {
  test("bearer with the dictation header returns the text", async () => {
    const h = build();
    const made = await connect(h, "1".repeat(32));
    const answer = await transcribe(h, slice(made.token));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ text: "hello from the fake" });
  });

  test("bearer without the dictation header is refused", async () => {
    const h = build();
    const made = await connect(h, "2".repeat(32));
    expect((await transcribe(h, slice(made.token, false))).status).toBe(403);
  });

  test("no credentials is refused", async () => {
    const h = build();
    expect((await transcribe(h, slice())).status).toBe(401);
  });

  test("two concurrent slices for one person get one 429", async () => {
    const h = build();
    const made = await connect(h, "3".repeat(32));
    hold = true;
    const parked = new Promise<void>((resolve) => (reached = resolve));
    try {
      const first = transcribe(h, slice(made.token));
      await parked;
      expect((await transcribe(h, slice(made.token))).status).toBe(429);
      release();
      expect((await first).status).toBe(200);
    } finally {
      hold = false;
      release();
    }
  });
});
