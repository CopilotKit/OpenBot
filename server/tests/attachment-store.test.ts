import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { MAX_IMAGE_BYTES } from "../../shared/attachments";
import { createApp, UPLOAD_BODY_LIMIT_BYTES } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "../src/channels/attachments";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const testPrefix = `attachment-store-${randomUUID()}`;
const createdAttachmentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  for (const id of createdAttachmentIds.splice(0)) {
    await database.delete(attachments).where(eq(attachments.id, id));
  }
  for (const id of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/** A user and a channel to hang an attachment off of, nothing more. */
async function seedChannel(db: typeof database) {
  const userId = `${testPrefix}-user-${randomUUID()}`;
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
  });
  createdUserIds.push(userId);

  const channelId = `${testPrefix}-channel-${randomUUID()}`;
  await db.insert(channels).values({
    id: channelId,
    name: "Attachment Store Test Channel",
    description: "Round-trip test channel.",
  });
  createdChannelIds.push(channelId);

  return { userId, channelId };
}

describe("an attachment's bytes through the bytea column", () => {
  test("survive the round trip unchanged, byte for byte", async () => {
    const { userId, channelId } = await seedChannel(database);
    // Deliberately includes both a null byte and 0xff: a driver that
    // treats bytea as text would mangle one of these on the way through.
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0xff]);

    const [inserted] = await database
      .insert(attachments)
      .values({
        channelId,
        uploadedBy: userId,
        name: "test.bin",
        mimeType: "application/octet-stream",
        sizeBytes: payload.byteLength,
        bytes: payload,
      })
      .returning();
    createdAttachmentIds.push(inserted.id);

    const [read] = await database
      .select()
      .from(attachments)
      .where(eq(attachments.id, inserted.id));

    expect(Buffer.compare(read.bytes, payload)).toBe(0);
    expect(read.attachedAt).toBeNull();
  });
});

/*
 * THE ONE TEST THAT CARRIES BYTES THROUGH BOTH DOORS AND COMPARES THEM.
 *
 * It used to claim to be the only test that used the upload route at all, and that has not been
 * true for a while: `attachment-routes.test.ts` uploads through the route and fetches the result
 * back in several places — the SVG-body case, the over-long filename case, the cap races. What none
 * of those do is compare the BYTES. They assert statuses, headers and stored names, so a POST
 * handler that wrote `bytes.slice(0, 1)` or `sizeBytes: 0` would keep every one of them green.
 *
 * That is what this one is for, and the claim is worth keeping narrow so it stays true. Most
 * attachment tests still seed their rows with a direct insert, which leaves the route's own
 * handling of the body asserted by nothing; here the bytes are compared against the buffer the
 * REQUEST was built from — not against anything read back out of the table — and the headers are
 * read off the response rather than derived from the row, so a regression anywhere between the
 * multipart body and the served response is a failure here.
 */
describe("a file uploaded through the route and fetched back", () => {
  /** Signs every request as one person, which is who the channel membership below is for. */
  function actorMiddleware(
    actorId: string,
  ): MiddlewareHandler<{ Variables: AppVariables }> {
    return async (context, next) => {
      context.set("actor", {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "user",
      });
      await next();
    };
  }

  test("comes back byte for byte, under the headers it was stored with", async () => {
    const { userId, channelId } = await seedChannel(database);
    await database.insert(channelMemberships).values({ channelId, userId });

    /*
     * A real PNG signature so the route's sniffer names it `image/png` on the bytes rather than on
     * the claim, then a body chosen to break anything that treats these bytes as text: a NUL, a
     * 0xff, a lone 0x0d and the 0x0d 0x0a pair a transport that thinks it is handling lines would
     * rewrite.
     */
    const payload = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x0d,
      0x0d, 0x0a, 0x7f, 0x80, 0x00, 0x01,
    ]);

    const actor = actorMiddleware(userId);
    const uploads = new Hono<{ Variables: AppVariables }>();
    uploads.route("/", createChannelAttachmentRoutes(database, actor));

    const body = new FormData();
    body.set(
      "file",
      new File([payload], "round-trip.png", { type: "image/png" }),
    );
    body.set("uploadGroup", randomUUID());
    const uploaded = await uploads.request(
      `http://test/${channelId}/attachments`,
      { method: "POST", body },
    );

    expect(uploaded.status).toBe(201);
    const created = (await uploaded.json()) as {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
    };
    createdAttachmentIds.push(created.id);
    expect(created.name).toBe("round-trip.png");
    expect(created.mimeType).toBe("image/png");
    // The length the route recorded, which is the field a truncating upload would have to lie
    // about to keep the round trip below looking consistent.
    expect(created.sizeBytes).toBe(payload.byteLength);

    const fetches = new Hono<{ Variables: AppVariables }>();
    fetches.route("/", createAttachmentRoutes(database, actor));
    const served = await fetches.request(`http://test/${created.id}`);

    expect(served.status).toBe(200);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    // Against the buffer the request was built from. Comparing lengths first only so a failure says
    // "truncated" rather than printing two buffers.
    expect(servedBytes.byteLength).toBe(payload.byteLength);
    expect(Buffer.compare(servedBytes, payload)).toBe(0);

    // The type the server sniffed, never the claim, and the two headers that keep a served
    // attachment from being run as a page on this app's origin.
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-disposition")).toBe("inline");
    // `no-cache` rather than a max-age, and the ETag beside it, are what let a DELETED attachment
    // stop being served: the browser must revalidate every time, and the revalidation is answered
    // behind the same channel-and-membership join a 200 is. A max-age here would put the
    // "unavailable" path out of reach for the length of the window.
    expect(served.headers.get("cache-control")).toBe("private, no-cache");
    expect(served.headers.get("etag")).toBe(`"${created.id}"`);
  });
});

/**
 * A channel this user is a member of, so an upload through the real app reaches the handler rather
 * than its 403. `seedChannel` alone makes a channel nobody belongs to.
 */
async function seedMemberChannel() {
  const { userId, channelId } = await seedChannel(database);
  await database.insert(channelMemberships).values({ channelId, userId });
  return { userId, channelId };
}

/**
 * The whole app, wired to this database and signed in as `userId`.
 *
 * `createApp` positionally, the same as attachment-routes.test.ts does: positions 4-25 are the
 * stores this file has nothing to say about, and `attachmentDatabase` is position 26. It has to be
 * the whole app rather than `createChannelAttachmentRoutes` on its own, because the body limit
 * under test is mounted in app.ts and does not exist on the router by itself.
 */
function appSignedInAs(userId: string) {
  return createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: {
            id: userId,
            email: `${userId}@example.test`,
            name: "Attachment Store Test User",
            image: "https://example.test/avatar.png",
          },
        }),
      },
    },
    { rolesForUser: async () => ["user"] },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    database,
  );
}

/**
 * `size` bytes that a mime sniff will call a PNG. The signature is load-bearing: an `image/png`
 * claim the bytes do not corroborate comes back 415 on the file, which would pass a status
 * assertion about a size limit for entirely the wrong reason.
 */
function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function uploadRequest(
  app: ReturnType<typeof appSignedInAs>,
  channelId: string,
  file: File,
) {
  const formData = new FormData();
  formData.set("file", file);
  formData.set("uploadGroup", randomUUID());
  return app.request(
    `http://openbot.test/api/channels/${channelId}/attachments`,
    { method: "POST", body: formData },
  );
}

/** The rows this channel holds, so a refusal can be checked against its own channel and no other. */
async function rowsIn(channelId: string) {
  return await database
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.channelId, channelId));
}

describe("the body limit in front of the upload route", () => {
  test("accepts an image of exactly MAX_IMAGE_BYTES, the documented ceiling", async () => {
    const { userId, channelId } = await seedMemberChannel();
    const app = appSignedInAs(userId);

    const response = await uploadRequest(
      app,
      channelId,
      new File([pngOfSize(MAX_IMAGE_BYTES)], "ceiling.png", {
        type: "image/png",
      }),
    );

    // RED before the fix: the limit was `MAX_IMAGE_BYTES` measured over the whole multipart
    // envelope, so the ~360 bytes of boundary and headers around a file at the ceiling pushed the
    // body past it and this came back 413. A file at the number every other gate publishes could
    // not be uploaded at all.
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      sizeBytes: number;
    };
    createdAttachmentIds.push(created.id);
    expect(created.sizeBytes).toBe(MAX_IMAGE_BYTES);
  });

  test("refuses an image one byte past MAX_IMAGE_BYTES with a reason the composer can read", async () => {
    const { userId, channelId } = await seedMemberChannel();
    const app = appSignedInAs(userId);

    const response = await uploadRequest(
      app,
      channelId,
      new File([pngOfSize(MAX_IMAGE_BYTES + 1)], "over.png", {
        type: "image/png",
      }),
    );

    expect(response.status).toBe(413);
    const text = await response.text();
    // The composer reads `{ error }` off every failure and falls back to a generic "Could not
    // upload" when the body is not JSON, so the shape is the message.
    const body = JSON.parse(text) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("8MB");
    expect(await rowsIn(channelId)).toEqual([]);
  });

  test("refuses a body past the door's own ceiling in that same JSON shape", async () => {
    const { userId, channelId } = await seedMemberChannel();
    const app = appSignedInAs(userId);

    // Past `UPLOAD_BODY_LIMIT_BYTES`, so the refusal comes from the middleware rather than the
    // handler: this is the path that exists to stop an unbounded body being read into memory, and
    // it is the one that used to answer in plain text.
    const response = await uploadRequest(
      app,
      channelId,
      new File([pngOfSize(UPLOAD_BODY_LIMIT_BYTES + 1)], "enormous.png", {
        type: "image/png",
      }),
    );

    expect(response.status).toBe(413);
    const text = await response.text();
    // RED before the fix: hono's default 413 body is the plain string "Payload Too Large", so this
    // parse threw and the person saw the generic "Could not upload" with no reason in it.
    const body = JSON.parse(text) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("8MB");
    expect(await rowsIn(channelId)).toEqual([]);
  });
});

describe("the attachments table's cascading foreign keys", () => {
  test("index uploaded_by, so removing a person is not a sequential scan of the blob table", async () => {
    const indexes = (await database.execute(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = current_schema() and tablename = 'attachments'
    `)) as unknown as { indexname: string; indexdef: string }[];

    /*
     * The LEADING column, not merely a column that appears somewhere. `attachments_upload_group_idx`
     * already names `uploaded_by` — as its second key, behind `channel_id`, and behind a partial
     * predicate on top — and Postgres cannot drive a lookup on `uploaded_by` alone from it. Matching
     * on the definition rather than on an index name keeps this a statement about the property the
     * cascade needs, so renaming the index does not fail it and adding an unrelated one does not
     * pass it.
     */
    const leadsOnUploadedBy = indexes.filter((index) =>
      /USING btree \(uploaded_by[),]/.test(index.indexdef),
    );

    // RED before the fix: `attachments` had `attachments_channel_idx` for one of its two cascading
    // foreign keys and nothing at all for the other, so `delete from users` scanned every row of
    // the one table in this deployment that stores blobs.
    expect(leadsOnUploadedBy.length).toBeGreaterThan(0);
    /*
     * AT LEAST ONE OF THEM UNFILTERED, rather than all of them. A cascade has to find every row that
     * names the departing user, including the ones already stamped as sent, so a partial index on
     * the staged minority cannot serve it and an unfiltered one has to exist.
     *
     * It may not be the only one, though, and this used to say that it was. The staging backstop
     * (`MAX_STAGED_ATTACHMENTS_PER_UPLOADER` in channels/attachments.ts) counts
     * `uploaded_by = ? and attached_at is null` on every upload, and the index that would suit it
     * best is exactly the partial one the old assertion forbade. Written this way the test still
     * pins the property the cascade needs, and stops being the reason a later index cannot be added.
     */
    expect(
      leadsOnUploadedBy.filter((index) => !index.indexdef.includes("WHERE")),
    ).not.toHaveLength(0);
  });

  test("actually cascade a removed person's attachments away", async () => {
    const { userId, channelId } = await seedChannel(database);
    const [inserted] = await database
      .insert(attachments)
      .values({
        channelId,
        uploadedBy: userId,
        name: "theirs.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        bytes: Buffer.from("hello"),
      })
      .returning();

    await database.delete(users).where(eq(users.id, userId));

    const survivors = await database
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, inserted.id));
    expect(survivors).toEqual([]);
  });
});
