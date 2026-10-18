import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ExchangeResponse,
  type MediaRecord,
  RECORDER_MEDIA_CHUNK_BYTES,
  RECORDER_SIGNED_OUT,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { demonstrations } from "../src/db/schema/demonstrations";
import { createRecorderExtension } from "../src/recorder/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-media-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const ownDemonstration = `${prefix}-own`;
const foreignDemonstration = `${prefix}-foreign`;
const cloudDemonstration = `${prefix}-cloud`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const COOKIE = { cookie: "test-session=owner" };
const SCREEN = { kind: "screen", mimeType: "video/webm;codecs=vp9,opus" };

function build() {
  const config = loadConfig(testEnvironment());
  const auditStore = { insert: async (_event: AuditEventInput) => {} };
  const roleRepository = { rolesForUser: async () => ["user" as const] };
  const recorder = createRecorderExtension({
    config,
    database,
    organizationAuth: undefined,
    roleRepository,
    peopleStore: { isRevoked: async () => false },
    agentProfileStore: {
      list: async () => [],
      get: async () => null,
    } as never,
    pluginStore: { agentOwner: async () => null },
    actorFor: async (id) => ({ id, role: "user" }),
    learningSettingsStore: { read: async () => ({}) as never },
    snapshots: { getLearnedSkillsSnapshot: async () => ({}) as never },
    demonstrations: {} as never,
    auditStore,
  });
  return createApp(
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
}

const app = build();
const call = (path: string, init: RequestInit = {}) =>
  app.request(`http://openbot.test${path}`, init);
const json = (token: string | undefined, body: unknown): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
const chunk = (token: string | undefined, size: number): RequestInit => ({
  method: "PUT",
  headers: {
    "content-type": "application/octet-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: new Uint8Array(size).fill(7),
});

let token = "";

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "The Owner" },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: bot,
    type: "built_in" as const,
    configuration: {},
  });
  await database.insert(demonstrations).values([
    {
      id: ownDemonstration,
      ownerUserId: owner,
      botId: bot,
      title: "Own",
      source: "extension",
      status: "stopped",
    },
    {
      id: foreignDemonstration,
      ownerUserId: other,
      botId: bot,
      title: "Foreign",
      source: "extension",
      status: "stopped",
    },
    {
      id: cloudDemonstration,
      ownerUserId: owner,
      botId: bot,
      title: "Cloud",
      source: "computer",
      status: "stopped",
    },
  ]);
  const minted = await call("/api/recorder/connect-codes", {
    ...json(undefined, { via: "web" }),
    headers: { "content-type": "application/json", ...COOKIE },
  });
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call("/api/recorder/connections", {
    ...json(undefined, {
      code,
      label: "Chrome on macOS",
      installId: "e".repeat(32),
    }),
    headers: { "content-type": "application/json", origin: ORIGIN },
  });
  expect(exchanged.status).toBe(201);
  token = ((await exchanged.json()) as ExchangeResponse).token;
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot]));
  await database.$client.close();
});

async function create(
  body: unknown = SCREEN,
  demonstration = ownDemonstration,
) {
  const response = await call(
    recorderPaths.media(demonstration),
    json(token, body),
  );
  return {
    response,
    media:
      response.status === 201
        ? ((await response.json()) as { media: MediaRecord }).media
        : undefined,
  };
}

describe("the Recorder's media routes", () => {
  test("a screen media is created, filled, read back and completed", async () => {
    const { response, media } = await create();
    expect(response.status).toBe(201);
    if (!media) throw new Error("no media");
    expect(media).toMatchObject({
      kind: "screen",
      chunks: [],
      completedAt: null,
    });
    const put = await call(
      recorderPaths.mediaChunk(ownDemonstration, media.id, 0),
      chunk(token, 1000),
    );
    expect(put.status).toBe(200);
    const read = await call(
      recorderPaths.mediaItem(ownDemonstration, media.id),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(((await read.json()) as { media: MediaRecord }).media).toMatchObject(
      {
        chunks: [0],
        byteSize: 1000,
      },
    );
    const complete = await call(
      recorderPaths.mediaComplete(ownDemonstration, media.id),
      json(token, { chunkCount: 1 }),
    );
    expect(complete.status).toBe(200);
    expect(
      ((await complete.json()) as { media: MediaRecord }).media.completedAt,
    ).not.toBeNull();
  });

  test("an audio media with audio/webm;codecs=opus is created", async () => {
    const { response, media } = await create({
      kind: "audio",
      mimeType: "audio/webm;codecs=opus",
    });
    expect(response.status).toBe(201);
    expect(media?.mimeType).toBe("audio/webm;codecs=opus");
  });

  test("a kind and type that do not match are refused", async () => {
    const { response } = await create({
      kind: "network",
      mimeType: "video/webm",
    });
    expect(response.status).toBe(400);
  });

  test("a chunk of exactly 512 KiB is accepted and one byte more is a 413", async () => {
    const { media } = await create();
    if (!media) throw new Error("no media");
    const path = (index: number) =>
      recorderPaths.mediaChunk(ownDemonstration, media.id, index);
    const exact = await call(path(0), chunk(token, RECORDER_MEDIA_CHUNK_BYTES));
    expect(exact.status).toBe(200);
    const over = await call(
      path(1),
      chunk(token, RECORDER_MEDIA_CHUNK_BYTES + 1),
    );
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({
      error: "A recording chunk must be 512 KiB or smaller.",
    });
  });

  test("a chunk must be sent as octet-stream", async () => {
    const { media } = await create();
    if (!media) throw new Error("no media");
    const refused = await call(
      recorderPaths.mediaChunk(ownDemonstration, media.id, 0),
      {
        ...chunk(token, 10),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
        },
      },
    );
    expect(refused.status).toBe(415);
  });

  test("a chunk index that is not a whole number from zero is refused", async () => {
    const { media } = await create();
    if (!media) throw new Error("no media");
    for (const index of ["-1", "1.5", "abc"]) {
      const refused = await call(
        `${recorderPaths.media(ownDemonstration)}/${media.id}/chunks/${index}`,
        chunk(token, 10),
      );
      expect(refused.status).toBe(400);
    }
  });

  test("completing with a gap is a 409 and a chunk after completing is a 409", async () => {
    const { media } = await create();
    if (!media) throw new Error("no media");
    await call(
      recorderPaths.mediaChunk(ownDemonstration, media.id, 0),
      chunk(token, 10),
    );
    const gap = await call(
      recorderPaths.mediaComplete(ownDemonstration, media.id),
      json(token, { chunkCount: 2 }),
    );
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({
      error: "Some of the recording is still uploading.",
    });
    await call(
      recorderPaths.mediaComplete(ownDemonstration, media.id),
      json(token, { chunkCount: 1 }),
    );
    const late = await call(
      recorderPaths.mediaChunk(ownDemonstration, media.id, 1),
      chunk(token, 10),
    );
    expect(late.status).toBe(409);
  });

  test("another person's demonstration and an unknown media are 404", async () => {
    const foreign = await create(SCREEN, foreignDemonstration);
    expect(foreign.response.status).toBe(404);
    const unknown = await call(
      recorderPaths.mediaItem(ownDemonstration, randomUUID()),
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(unknown.status).toBe(404);
  });

  test("a cloud-browser demonstration refuses media", async () => {
    const { response } = await create(SCREEN, cloudDemonstration);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Only recordings made in the browser extension keep media.",
    });
  });

  test("a create body over 2 KiB is a 413 and a form post is a 415", async () => {
    const big = await call(
      recorderPaths.media(ownDemonstration),
      json(token, { ...SCREEN, padding: "x".repeat(3000) }),
    );
    expect(big.status).toBe(413);
    const form = await call(recorderPaths.media(ownDemonstration), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify(SCREEN),
    });
    expect(form.status).toBe(415);
  });

  test("no bearer is a 401 RECORDER_SIGNED_OUT on every route", async () => {
    const { media } = await create();
    if (!media) throw new Error("no media");
    const refusals = await Promise.all([
      call(recorderPaths.media(ownDemonstration), json(undefined, SCREEN)),
      call(
        recorderPaths.mediaChunk(ownDemonstration, media.id, 0),
        chunk(undefined, 10),
      ),
      call(recorderPaths.mediaItem(ownDemonstration, media.id)),
      call(
        recorderPaths.mediaComplete(ownDemonstration, media.id),
        json(undefined, { chunkCount: 0 }),
      ),
    ]);
    for (const refused of refusals) {
      expect(refused.status).toBe(401);
      expect(((await refused.json()) as { code: string }).code).toBe(
        RECORDER_SIGNED_OUT,
      );
    }
  });

  test("no route answers GET on the media collection", async () => {
    const listed = await call(recorderPaths.media(ownDemonstration), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(404);
  });
});
