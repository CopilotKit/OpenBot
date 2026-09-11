import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  attachmentUrl,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "../../shared/attachments";
import { createApp, UPLOAD_BODY_LIMIT_BYTES } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { resolveAttachmentParts } from "../src/channels/attachment-parts";
import {
  contentDispositionFilename,
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
  loadAttachmentForTurn,
  markAttachmentsSent,
  MAX_STAGED_ATTACHMENTS_PER_UPLOADER,
} from "../src/channels/attachments";
import { loadConfig } from "../src/config";
import type { Database } from "../src/db/client";
import { createDatabase } from "../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const testPrefix = `attachment-routes-${randomUUID()}`;
const createdChannelIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  // Cascades attachments and memberships tied to the channel.
  for (const id of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
  await unreachableDatabase.$client.close();
});

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

/** A member of a channel, a stranger to it, and an app that uploads as the member. */
async function harness() {
  const memberId = `${testPrefix}-member-${randomUUID()}`;
  const strangerId = `${testPrefix}-stranger-${randomUUID()}`;
  await database.insert(users).values([
    { id: memberId, email: `${memberId}@example.test` },
    { id: strangerId, email: `${strangerId}@example.test` },
  ]);
  createdUserIds.push(memberId, strangerId);

  const channelId = `${testPrefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id: channelId,
    name: "Attachment Route Test Channel",
    description: "A channel to upload files into.",
  });
  createdChannelIds.push(channelId);

  await database
    .insert(channelMemberships)
    .values({ channelId, userId: memberId });

  /*
   * The thread this channel's conversation runs in, because in production a channel never exists
   * without one: `makeChannel` writes the membership row and the mapping row in a single
   * transaction, so membership and mapping are 1:1 and a member with no mapping cannot even see the
   * channel (`get` and `list` inner-join it).
   *
   * It is here rather than in the two tests that care because the turn path is now scoped to the
   * conversation as well as to the actor, and a fixture with no mapping would put every test in
   * this file on the unmapped branch — the branch that exists for hops and the direct `/bot` chat,
   * not for a channel. Tests would then agree with each other and with nothing that ships.
   */
  const threadId = `${testPrefix}-thread-${randomUUID()}`;
  await database
    .insert(intelligenceChannelMappings)
    .values({ channelId, userId: memberId, threadId });

  const member = actorMiddleware(memberId);
  const stranger = actorMiddleware(strangerId);

  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelAttachmentRoutes(database, member));

  return {
    app,
    channelId,
    database,
    member,
    stranger,
    memberId,
    strangerId,
    threadId,
  };
}

function upload(
  app: Hono<{ Variables: AppVariables }>,
  channelId: string,
  file: File,
  uploadGroup?: string,
) {
  const formData = new FormData();
  formData.set("file", file);
  // Omitted where a test does not care, which is also the shape an older tab still sends: the
  // route counts those together in one legacy bucket rather than in nobody's.
  if (uploadGroup !== undefined) formData.set("uploadGroup", uploadGroup);
  return app.request(`http://test/${channelId}/attachments`, {
    method: "POST",
    body: formData,
  });
}

/** An app wired to the `/:id` GET and DELETE routes, acting as the given actor. */
function attachmentApp(
  db: Database,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAttachmentRoutes(db, requireUser));
  return app;
}

/**
 * A database at an address nothing is listening on.
 *
 * The failures these routes have to answer for — a connection lost during a rollout, a pool with
 * nothing left in it, a `statement_timeout` — are all "the driver could not answer this query", and
 * a closed port produces exactly that, from the real driver, without a mock standing in for it.
 * Bun's SQL connects lazily, so building this costs nothing and no connection is ever held; the
 * query rejects in about 2ms.
 */
const unreachableDatabase = createDatabase(
  "postgres://openbot:openbot@127.0.0.1:1/openbot",
  { max: 1 },
);

/**
 * The same database, except that opening a transaction fails.
 *
 * The unreachable database above cannot reach the transaction at all: the upload route's membership
 * check is the first thing to fail, so the deeper guard is never exercised. This one lets every
 * real statement through and fails only where the insert happens, which is the line the finding is
 * about — a pool exhausted, a lock timeout or a full disk, once the request is already inside.
 */
function databaseWhoseTransactionFails(db: Database): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return () => Promise.reject(new Error("could not open a transaction"));
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

/**
 * The same database, except that a withdrawal lands the moment the upload's own statement has run.
 *
 * THE RACE THIS PARKS CANNOT BE PARKED WITH A LOCK. The upload holds a `pg_advisory_xact_lock` on
 * its uploader, which serialises other UPLOADS and nothing else — a
 * `DELETE /api/attachments/:id` takes no such lock and commits straight away. So the only way to
 * put a withdrawal exactly between the statement that refuses and any statement that might explain
 * the refusal is to hang it off the statements themselves, which is what this does: the first
 * `execute` in the transaction is the advisory lock, the second is the upload's own statement, and
 * `withdraw` runs the instant that second one comes back.
 *
 * Under READ COMMITTED every later statement in the same transaction takes a FRESH snapshot, so
 * anything the handler asks after this point sees the withdrawn row as gone. That is precisely the
 * fault: the count that explains a refusal must come from the statement that refused.
 */
function databaseWithdrawingAfterTheInsert(
  db: Database,
  withdraw: () => Promise<void>,
): Database {
  let statements = 0;
  const watch = (transaction: object) =>
    new Proxy(transaction, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        if (property !== "execute") return value.bind(target);
        return async (...args: unknown[]) => {
          const result = await (
            value as (...called: unknown[]) => Promise<unknown>
          ).apply(target, args);
          statements += 1;
          if (statements === 2) await withdraw();
          return result;
        };
      },
    });

  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "transaction") return value.bind(target);
      return (callback: (transaction: object) => unknown, ...rest: unknown[]) =>
        (value as (...called: unknown[]) => unknown).call(
          target,
          (transaction: object) => callback(watch(transaction)),
          ...rest,
        );
    },
  }) as Database;
}

/**
 * The same database, remembering which columns each `select` asked for.
 *
 * "The probe does not read the file" is not visible in a HEAD response — the body is empty either
 * way, and the only other evidence is a stopwatch, which is a guess about how fast this machine is.
 * The column list is the fact itself: `bytes` is either in the statement or it is not.
 */
function databaseRecordingSelections(
  db: Database,
  selections: string[][],
): Database {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "select") return value.bind(target);
      return (fields?: Record<string, unknown>) => {
        selections.push(Object.keys(fields ?? {}));
        return (value as (...called: unknown[]) => unknown).call(
          target,
          fields,
        );
      };
    },
  }) as Database;
}

/**
 * Runs `work` with `console.error` captured rather than printed, and hands back what it logged.
 *
 * Both halves matter. A failure nobody can see from the outside is half the fault these tests pin —
 * the finding was that a database error reached the client as an unreadable 500 AND left no trace
 * on this side — so the log line is asserted, not merely tolerated. Capturing also keeps a
 * deliberate failure from printing a stack trace into a passing suite, where the next person would
 * read it as something going wrong.
 */
async function withCapturedErrorLog<T>(
  work: () => Promise<T>,
): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      logged.push(args.map((argument) => String(argument)).join(" "));
    },
  );
  try {
    return { result: await work(), logged };
  } finally {
    spy.mockRestore();
  }
}

/** Inserts a staged (or sent, if `attachedAt` is given) attachment row directly, bypassing upload. */
async function uploadBytes(
  db: Database,
  options: {
    channelId: string;
    uploadedBy: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    attachedAt?: Date;
  },
): Promise<string> {
  const [inserted] = await db
    .insert(attachments)
    .values({
      channelId: options.channelId,
      uploadedBy: options.uploadedBy,
      name: options.name,
      mimeType: options.mimeType,
      sizeBytes: options.bytes.byteLength,
      bytes: Buffer.from(options.bytes),
      attachedAt: options.attachedAt ?? null,
    })
    .returning({ id: attachments.id });
  return inserted.id;
}

/** Same as `uploadBytes`, for a text body, defaulting to `text/plain`. */
function uploadText(
  db: Database,
  options: {
    channelId: string;
    uploadedBy: string;
    name: string;
    mimeType?: string;
    text: string;
    attachedAt?: Date;
  },
): Promise<string> {
  return uploadBytes(db, {
    channelId: options.channelId,
    uploadedBy: options.uploadedBy,
    name: options.name,
    mimeType: options.mimeType ?? "text/plain",
    bytes: new TextEncoder().encode(options.text),
    attachedAt: options.attachedAt,
  });
}

/**
 * The `attachedAt` a row currently carries, `null` when it is staged, or `undefined` when there is
 * no such row at all.
 *
 * THREE-VALUED ON PURPOSE, AND THAT IS A TRAP FOR THE CALLER. `expect(...).not.toBeNull()` is
 * satisfied by the `undefined` — so a test meaning "the row is still here and stamped" passes just
 * as happily when the row was deleted out from under it, which is the failure some of these tests
 * exist to catch. Assert `toBeInstanceOf(Date)` for that, never `not.toBeNull()`.
 */
async function attachedAtOf(
  db: Database,
  id: string,
): Promise<Date | null | undefined> {
  const [row] = await db
    .select({ attachedAt: attachments.attachedAt })
    .from(attachments)
    .where(eq(attachments.id, id));
  return row?.attachedAt;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/**
 * How long {@link waitForBlockedSession} waits before saying so itself.
 *
 * IT HAS TO BE COMFORTABLY UNDER THE TEST'S OWN TIMEOUT, and it used to be exactly equal to it: the
 * deadline was 5s and Bun's default per-test timeout is also 5s, with no override anywhere, so the
 * test was always killed by the runner a moment before the helper could raise. The message below —
 * the one thing that says WHICH session never blocked — was unreachable, and every failure of these
 * races read as a bare "timed out after 5000ms".
 *
 * So the deadline is a third of the timeout the two callers now declare, which leaves the helper's
 * own diagnostic the thing that fires.
 */
const BLOCKED_SESSION_TIMEOUT_MS = 20_000;
const BLOCKED_SESSION_DEADLINE_MS = BLOCKED_SESSION_TIMEOUT_MS / 3;

/**
 * Waits until the named session is actually waiting on somebody else's lock.
 *
 * A sleep would make the race below a guess about how fast this machine is; `pg_blocking_pids` is
 * Postgres saying so itself. `settled` is the other way out: a request that answered without ever
 * blocking has nothing left to wait for, and returning false lets the test say which of the two
 * happened rather than time out on a question already answered.
 *
 * The poll has a pause in it, which it did not before. Without one this loop asks
 * `pg_stat_activity` as fast as the connection will answer — a view Postgres builds by walking
 * every backend — on the one connection the racing request may itself be waiting for, on a database
 * other agents' suites are using at the same time. 10ms is far below the window being observed and
 * turns thousands of round trips into a handful.
 */
async function waitForBlockedSession(
  applicationName: string,
  settled: () => boolean,
  // Overridden by the test that pins the message below, and by nothing else: waiting the real
  // deadline out to watch it fire would put seven seconds on the suite to observe a string.
  deadlineMs: number = BLOCKED_SESSION_DEADLINE_MS,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const blocked = await database.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (blocked.length > 0) return true;
    if (settled()) return false;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out observing blocked session ${applicationName}.`);
}

/** The transaction handle drizzle hands a `db.transaction` callback, named so a helper can pass it on. */
type HeldTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs `markAttachmentsSent` into a row another transaction is already holding, and lets the caller
 * decide what happens to that row while the stamp is stuck waiting for it.
 *
 * THIS IS THE GAP BETWEEN THE LOAD AND THE STAMP, MADE OBSERVABLE. `inlineAttachments` reads an
 * attachment's bytes, then walks the rest of the history, and only then records the send — so
 * anything that can take the row commits inside a window that is as long as the history is. A
 * `SELECT … FOR UPDATE` holds the row without changing it, which is what puts the stamp in that
 * window on purpose rather than hoping the two land in the right order; `pg_blocking_pids` is
 * Postgres confirming the stamp really is waiting, so the interleaving is observed rather than
 * assumed. Then `whileBlocked` runs in the holding transaction and it commits, and what the stamp
 * does when it wakes is the whole of each test below.
 *
 * A CONNECTION OF ITS OWN, `{ max: 1 }` and named, for the reasons the upload and delete races give
 * at length: `pg_blocking_pids` needs a session it can point at, every pool this suite opens is held
 * for the whole run, and the stamp issues its statements one after another anyway.
 *
 * Hands back whatever `markAttachmentsSent` rejected with, or null when it resolved. Returned rather
 * than rethrown so the caller can assert on either outcome, and captured in the handler rather than
 * left on a floating promise so a rejection is never momentarily unhandled.
 */
async function stampWhileTheRowIsHeld(
  db: Database,
  turn: { actorId: string; threadId: string },
  id: string,
  whileBlocked: (held: HeldTransaction) => Promise<void>,
): Promise<unknown> {
  const applicationName = `attachment_stamp_race_${randomUUID()}`;
  const namedUrl = new URL(databaseUrl);
  namedUrl.searchParams.set("application_name", applicationName);
  const namedDatabase = createDatabase(namedUrl.toString(), { max: 1 });

  const rowHeld = deferred();
  const release = deferred();
  const holder = db.transaction(async (transaction) => {
    await transaction
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, id))
      .for("update");
    rowHeld.resolve();
    await release.promise;
    await whileBlocked(transaction);
  });
  void holder.catch(rowHeld.reject);

  try {
    await rowHeld.promise;
    let settled = false;
    let outcome: unknown = null;
    const stamping = markAttachmentsSent(namedDatabase, turn, [id]).then(
      () => {
        settled = true;
      },
      (reason: unknown) => {
        settled = true;
        outcome = reason;
      },
    );

    expect(await waitForBlockedSession(applicationName, () => settled)).toBe(
      true,
    );
    release.resolve();
    await holder;
    await stamping;
    return outcome;
  } finally {
    release.resolve();
    await holder.catch(() => undefined);
    await namedDatabase.$client.close();
  }
}

/**
 * The characters RFC 9110 does not allow in a field value: the C0 controls and DEL. Reported as
 * code points rather than as a boolean, so a failure names the byte that got through.
 */
function controlCharactersIn(value: string): string[] {
  return Array.from(value)
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    })
    .map((char) => `0x${(char.codePointAt(0) ?? 0).toString(16)}`);
}

describe("POST /:channelId/attachments", () => {
  test("a member uploads a PNG and gets back a staged attachment", async () => {
    const { app, channelId } = await harness();
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([bytes], "photo.png", { type: "image/png" });

    const response = await upload(app, channelId, file);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
    };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.mimeType).toBe("image/png");
    expect(body.name).toBe("photo.png");
  });

  test("a non-member uploading to the channel is refused", async () => {
    const { database: db, channelId, stranger } = await harness();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelAttachmentRoutes(db, stranger));
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", {
      type: "image/png",
    });

    const response = await upload(app, channelId, file);

    expect(response.status).toBe(403);
  });

  test("an SVG is refused, naming the SVG as the reason", async () => {
    const { app, channelId } = await harness();
    const svg = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    );
    const file = new File([svg], "x.svg", { type: "image/svg+xml" });

    const response = await upload(app, channelId, file);

    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("SVG");
  });

  test("a text file over the size limit is refused and writes no row", async () => {
    const { app, database: db, channelId } = await harness();
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61);
    const file = new File([oversized], "notes.txt", { type: "text/plain" });

    const response = await upload(app, channelId, file);

    expect(response.status).toBe(413);
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.channelId, channelId));
    expect(rows.length).toBe(0);
  });

  test("a non-multipart body is refused with a 400 and a reason", async () => {
    const { app, channelId } = await harness();

    const response = await app.request(`http://test/${channelId}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "a form" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("an unsupported non-image type is refused, naming the type", async () => {
    const { app, channelId } = await harness();
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "a.zip", {
      type: "application/zip",
    });

    const response = await upload(app, channelId, file);

    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("application/zip");
  });

  test("the ninth staged attachment in one upload group is refused", async () => {
    const { app, database: db, channelId, memberId } = await harness();
    await db.insert(attachments).values(
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => ({
        channelId,
        uploadedBy: memberId,
        uploadGroup: "one-composer",
        name: `staged-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 3,
        bytes: Buffer.from("abc"),
      })),
    );
    const file = new File([new TextEncoder().encode("abc")], "one-more.txt", {
      type: "text/plain",
    });

    const response = await upload(app, channelId, file, "one-composer");

    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    // The sentence has to name the limit, because the limit is the only actionable half...
    expect(error).toContain(
      `${MAX_ATTACHMENTS_PER_MESSAGE} files to a message`,
    );
    // ...and it may not describe the count as a channel total. It is scoped to one composer
    // session, which is the whole point of `upload_group`: a person with a full tab A and an empty
    // tab B was being sent hunting for files that are on another screen.
    expect(error).not.toContain("in this channel");
  });

  /**
   * THE 409 NOBODY COULD ACT ON, CLOSED.
   *
   * The cap is per message on the client, which can only count what is on its own screen, and used
   * to be per channel here. A closed tab, a stopped run or a removed queued message leaves staged
   * rows behind, and eight of them refused every upload a NEW composer made — naming files that
   * were on nobody's screen, for the 24 hours until the sweeper's window expired. The orphans are
   * still the sweeper's to reclaim; what they must not do is spend somebody else's cap.
   */
  test("an orphan from another upload group does not spend a new group's cap", async () => {
    const { app, database: db, channelId, memberId } = await harness();
    await db.insert(attachments).values(
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => ({
        channelId,
        uploadedBy: memberId,
        // A composer that is gone: its tab was closed with these still staged.
        uploadGroup: "a-tab-that-was-closed",
        name: `orphan-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 3,
        bytes: Buffer.from("abc"),
      })),
    );
    const file = new File([new TextEncoder().encode("abc")], "first.txt", {
      type: "text/plain",
    });

    const response = await upload(app, channelId, file, "a-fresh-composer");

    expect(response.status).toBe(201);
  });

  /*
   * THE HOLE UNDER THE PER-GROUP CAP, DRIVEN THROUGH THE ROUTE THE COMPOSER ACTUALLY POSTS TO.
   *
   * `uploadGroup` is a multipart form field and `uploadGroupOf` does not validate its value, so the
   * cap above counts a bucket the caller names. A caller that names a fresh one every time has zero
   * prior rows in every bucket it is ever counted against: before the backstop this loop wrote all
   * thirty-three rows, and nothing else in the server bounded staged `bytea` short of the 24-hour
   * culler.
   *
   * SEQUENTIAL, AND THE COUNT OF 201s IS THE ASSERTION. The point is not that some request
   * eventually fails; it is that the number of rows this person can stage has a ceiling at all, and
   * that the ceiling is the one written down. Whether the refusal arrives on the 33rd request or
   * some later one is the difference between a bound and no bound.
   */
  test("a fresh upload group on every request does not buy unlimited staging", async () => {
    const { app, channelId } = await harness();
    const attempts = MAX_STAGED_ATTACHMENTS_PER_UPLOADER + 1;
    const statuses: number[] = [];
    let lastError = "";

    for (let index = 0; index < attempts; index++) {
      const file = new File(
        [new TextEncoder().encode("abc")],
        `evade-${index}.txt`,
        { type: "text/plain" },
      );
      // A bucket nothing has ever been staged in, minted the way a real composer mints one.
      const response = await upload(app, channelId, file, randomUUID());
      statuses.push(response.status);
      if (response.status !== 201) {
        lastError = ((await response.json()) as { error: string }).error;
      }
    }

    expect(statuses.filter((status) => status === 201)).toHaveLength(
      MAX_STAGED_ATTACHMENTS_PER_UPLOADER,
    );
    expect(statuses.filter((status) => status === 409)).toHaveLength(
      attempts - MAX_STAGED_ATTACHMENTS_PER_UPLOADER,
    );
    // The two refusals must not be confusable. This one is about everything this person has
    // waiting, so it names that number and not the per-message limit — a person told "you can
    // attach 8 files to a message" while holding one file in this composer would go looking for
    // seven files that are not there.
    expect(lastError).toContain(String(MAX_STAGED_ATTACHMENTS_PER_UPLOADER));
    expect(lastError).toContain("waiting to send");
    expect(lastError).not.toContain("files to a message");

    /*
     * AND IT PROMISES NO SCHEDULE, BECAUSE THIS SERVER DOES NOT KNOW ONE.
     *
     * It used to end "anything still unsent is cleared within a day", which is a promise about
     * `attachments.culler.olderThanHours` — an operator's value, defaulting to 24 and documented as
     * raisable — made on a deployment that may also have set `attachments.culler.enabled: false`,
     * which charts/openbot/README.md offers as the way to "keep every staged row for ever". On such
     * a deployment the sentence was a flat lie told to the one person who could not act on it: some
     * of these rows are in channels they can no longer open, so withdrawing them is not available
     * either.
     *
     * Asserted as the absence of a deadline rather than as the new wording, so this keeps holding if
     * the sentence is rephrased and only stops holding if a duration comes back into it.
     */
    expect(lastError).not.toMatch(/within a (day|week|hour)|\d+\s*hours?/i);
  });

  /*
   * THE BACKSTOP IS NOT PER CHANNEL, because `POST /api/channels` is open to any authenticated user.
   * A ceiling that a new channel resets is a ceiling a client moves at will, which is the same
   * defect as one a new group moves.
   *
   * Seeded rather than uploaded: what is under test is which rows the count includes, and thirty-two
   * round trips through the multipart route to establish a precondition would be thirty-two chances
   * for this test to be about something else. The upload that decides it is a real one.
   */
  test("staged rows in another channel still count against the backstop", async () => {
    const { app, database: db, channelId, memberId } = await harness();

    const elsewhere = `${testPrefix}-channel-${randomUUID()}`;
    await db.insert(channels).values({
      id: elsewhere,
      name: "Another Channel Entirely",
      description: "Where this person has already staged their limit.",
    });
    createdChannelIds.push(elsewhere);
    await db
      .insert(channelMemberships)
      .values({ channelId: elsewhere, userId: memberId });

    await db.insert(attachments).values(
      Array.from({ length: MAX_STAGED_ATTACHMENTS_PER_UPLOADER }, (_, i) => ({
        channelId: elsewhere,
        uploadedBy: memberId,
        // A different group for every one of them, so no per-group count sees more than one.
        uploadGroup: randomUUID(),
        name: `elsewhere-${i}.txt`,
        mimeType: "text/plain",
        sizeBytes: 3,
        bytes: Buffer.from("abc"),
      })),
    );

    const file = new File([new TextEncoder().encode("abc")], "first.txt", {
      type: "text/plain",
    });
    const response = await upload(app, channelId, file, randomUUID());

    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("waiting to send");
  });

  /*
   * THE BACKSTOP UNDER THE SAME RACE THE CAP HAD TO BE FIXED FOR.
   *
   * Postgres is READ COMMITTED here, so `insert ... select ... where (select count(*)) < n` is not
   * atomic on its own: two statements in flight at once both count against a snapshot taken before
   * either committed, and both insert. The per-group cap answers that with a
   * `pg_advisory_xact_lock`, and that lock USED to be keyed on (channel, uploader, group) — which is
   * exactly the key an evading client varies, so it would have serialised nothing here. The key is
   * the uploader now, which is the scope this count is taken over.
   *
   * One row short of the ceiling, two uploads at once, two different groups, two different sessions
   * of the same person: exactly one may be accepted.
   */
  test("two uploads racing at the backstop in different groups leave only one accepted", async () => {
    const { app, database: db, channelId, memberId } = await harness();

    await db.insert(attachments).values(
      Array.from(
        { length: MAX_STAGED_ATTACHMENTS_PER_UPLOADER - 1 },
        (_, i) => ({
          channelId,
          uploadedBy: memberId,
          uploadGroup: randomUUID(),
          name: `already-${i}.txt`,
          mimeType: "text/plain",
          sizeBytes: 3,
          bytes: Buffer.from("abc"),
        }),
      ),
    );

    const responses = await Promise.all(
      [0, 1].map((index) =>
        upload(
          app,
          channelId,
          new File([new TextEncoder().encode("abc")], `race-${index}.txt`, {
            type: "text/plain",
          }),
          randomUUID(),
        ),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
  });

  /*
   * THE TRADE THE GROUPING BOUGHT, STILL BOUGHT. The backstop sits four messages above the cap
   * precisely so that the case `upload_group` was introduced for — a second tab, or a closed tab's
   * leftovers — keeps working. A person holding a full message's worth of orphans in one composer
   * session must still be able to compose the next message; that is the 409 nobody could act on,
   * and it stays closed.
   */
  test("a second composer session still gets its own eight under the backstop", async () => {
    const { app, database: db, channelId, memberId } = await harness();

    await db.insert(attachments).values(
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => ({
        channelId,
        uploadedBy: memberId,
        uploadGroup: "a-tab-that-was-closed",
        name: `orphan-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 3,
        bytes: Buffer.from("abc"),
      })),
    );

    const secondSession = randomUUID();
    const statuses: number[] = [];
    for (let index = 0; index < MAX_ATTACHMENTS_PER_MESSAGE; index++) {
      const file = new File(
        [new TextEncoder().encode("abc")],
        `fresh-${index}.txt`,
        { type: "text/plain" },
      );
      statuses.push((await upload(app, channelId, file, secondSession)).status);
    }

    expect(statuses.every((status) => status === 201)).toBe(true);
  });

  /**
   * THE CAP UNDER THE LOAD IT IS ACTUALLY MET WITH.
   *
   * Dropping nine files on the composer fires nine uploads at once by design, and the guard used to
   * be a count, a comparison and then an insert: every one of those requests counted the rows that
   * existed before any of them had written, all nine passed, and the person held nine. Sequential
   * uploads never showed it. Statuses are counted rather than rows, because what this pins is what
   * the door answered, not what the table happens to hold.
   */
  test("nine uploads racing in one group still leave only eight accepted", async () => {
    const { app, channelId } = await harness();
    const attempts = MAX_ATTACHMENTS_PER_MESSAGE + 1;

    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        upload(
          app,
          channelId,
          new File([new TextEncoder().encode("abc")], `race-${index}.txt`, {
            type: "text/plain",
          }),
          "one-composer-in-a-hurry",
        ),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 201)).toHaveLength(
      MAX_ATTACHMENTS_PER_MESSAGE,
    );
    expect(statuses.filter((status) => status === 409)).toHaveLength(
      attempts - MAX_ATTACHMENTS_PER_MESSAGE,
    );
  });
  /*
   * THE MEMBERSHIP CHECK AND THE INSERT ARE ONE STATEMENT, for the same reason the count and the
   * insert are.
   *
   * The route read membership at the top of the handler and then inserted on the strength of what
   * it had read — with the whole of `await file.arrayBuffer()`, the sniff and the classification in
   * between. A removal landing in that gap put a file into a channel its uploader had already been
   * taken out of, and the gap is as wide as reading an upload off the wire.
   *
   * Parked deterministically rather than hoped for. The upload's first act inside its transaction
   * is to take its uploader's advisory lock, so holding that exact lock first stops the request
   * precisely between its check and its insert. The removal commits, the lock is released, and what
   * the insert does when it finally runs is the whole test.
   *
   * The key is the uploader alone, and was (channel, uploader, group) until the staging backstop
   * needed a count no group could move. A group still goes into this upload because the route reads
   * one; it just no longer names the lock.
   */
  test(
    "a membership revoked mid-upload leaves no file in the channel",
    async () => {
      const { database: db, channelId, memberId, member } = await harness();
      const uploadGroup = randomUUID();

      /*
       * A named connection of its own, so `pg_blocking_pids` can point at the request's session, and
       * `{ max: 1 }` rather than `TEST_POOL` for the reason the delete race gives below: every pool
       * this suite opens is held for the whole run, and the request issues its statements one after
       * another anyway.
       */
      const applicationName = `attachment_upload_race_${randomUUID()}`;
      const namedUrl = new URL(databaseUrl);
      namedUrl.searchParams.set("application_name", applicationName);
      const namedDatabase = createDatabase(namedUrl.toString(), { max: 1 });

      const lockHeld = deferred();
      const releaseLock = deferred();
      const holder = db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`attachment-cap-${memberId}`}))`,
        );
        lockHeld.resolve();
        await releaseLock.promise;
      });
      void holder.catch(lockHeld.reject);

      let status: number | undefined;
      try {
        await lockHeld.promise;
        const app = new Hono<{ Variables: AppVariables }>();
        app.route("/", createChannelAttachmentRoutes(namedDatabase, member));
        const file = new File(
          [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
          "photo.png",
          { type: "image/png" },
        );

        let settled = false;
        const request = upload(app, channelId, file, uploadGroup).then(
          (value) => {
            settled = true;
            return value;
          },
          (reason: unknown) => {
            settled = true;
            throw reason;
          },
        );

        expect(
          await waitForBlockedSession(applicationName, () => settled),
        ).toBe(true);

        await db
          .delete(channelMemberships)
          .where(
            and(
              eq(channelMemberships.channelId, channelId),
              eq(channelMemberships.userId, memberId),
            ),
          );

        releaseLock.resolve();
        await holder;
        status = (await request).status;
      } finally {
        releaseLock.resolve();
        await holder.catch(() => undefined);
        await namedDatabase.$client.close();
      }

      expect(status).toBe(403);
      // The row, because a 403 answered over a file that had already landed would be the same failure
      // wearing the right status code.
      const rows = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.channelId, channelId));
      expect(rows.length).toBe(0);
      // Declared, so the helper's own "which session never blocked" diagnostic is what fires
      // when this race does not happen. See BLOCKED_SESSION_TIMEOUT_MS.
    },
    BLOCKED_SESSION_TIMEOUT_MS,
  );
  /*
   * A GROUP THIS SERVER CANNOT STORE IS A GROUP IT DOES WITHOUT.
   *
   * `upload_group` is the third column of `attachments_upload_group_idx`, and a btree entry may not
   * exceed about 2704 bytes, so a long enough group makes the INSERT itself fail. Measured through
   * this route against the local Postgres: 2000 bytes stored fine; 2600, 2700, 3000 and 8000 all
   * raised, and with no `app.onError` behind this router the person got a plain-text
   * `Internal Server Error` — the one shape the composer cannot read a reason out of.
   *
   * The upload is not refused, though, and that is the behaviour being pinned as much as the
   * absence of a 500: a group is a client-side hint nobody asked for, so one this server cannot
   * store is counted in the same bucket a request naming no group at all uses. This test proves it
   * landed in THAT bucket rather than merely somewhere, by filling the bucket first.
   */
  test("an upload group too long for the index is counted with the group-less ones", async () => {
    const { app, channelId } = await harness();
    // Incompressible: the index stores what it is given, and 4000 repeated characters would not be
    // the same test.
    const group = Array.from({ length: 200 }, () => randomUUID()).join("");
    expect(group.length).toBeGreaterThan(2704);

    // Seven with no group at all, which is the bucket a group this server drops falls back into.
    for (let index = 0; index < MAX_ATTACHMENTS_PER_MESSAGE - 1; index++) {
      const response = await upload(
        app,
        channelId,
        new File([new TextEncoder().encode("abc")], `staged-${index}.txt`, {
          type: "text/plain",
        }),
      );
      expect(response.status).toBe(201);
    }

    const eighth = await upload(
      app,
      channelId,
      new File([new TextEncoder().encode("abc")], "eighth.txt", {
        type: "text/plain",
      }),
      group,
    );
    const ninth = await upload(
      app,
      channelId,
      new File([new TextEncoder().encode("abc")], "ninth.txt", {
        type: "text/plain",
      }),
    );

    // Stored, rather than 500ing on the index...
    expect(eighth.status).toBe(201);
    // ...and stored in the group-less bucket, which the ninth then finds full.
    expect(ninth.status).toBe(409);
  });

  /*
   * A NUL is not a length problem and would survive a length check. Postgres refuses U+0000 in a
   * `text` value outright (`22021`), which takes down the one statement the group is bound into —
   * the upload's own count-and-insert CTE — so nothing is written and the upload is refused.
   *
   * This comment used to say the failure landed "one statement before the insert", on the advisory
   * lock. That was true of a lock keyed on `(channel, uploader, group)` and has not been true since
   * the key was widened to `attachment-cap-<actorId>`, which carries no group: re-measured against
   * the local Postgres, the lock takes a NUL-bearing group and an 8000-byte one without complaint.
   * The fallback below is still right, for the reason it was always really right — an upload with
   * nothing wrong with the FILE should not be refused over a cosmetic grouping hint.
   */
  test("an upload group carrying a NUL is stored as a group-less upload", async () => {
    const { app, channelId, database: db } = await harness();

    const response = await upload(
      app,
      channelId,
      new File([new TextEncoder().encode("abc")], "notes.txt", {
        type: "text/plain",
      }),
      "composer\u0000session",
    );

    expect(response.status).toBe(201);
    const groupless = await upload(
      app,
      channelId,
      new File([new TextEncoder().encode("abc")], "other.txt", {
        type: "text/plain",
      }),
    );
    expect(groupless.status).toBe(201);

    // Compared against what an upload naming no group at all stores, rather than against the
    // fallback's spelling, so the test pins the behaviour and not the constant.
    const groupOf = async (response: Response) => {
      const { id } = (await response.json()) as { id: string };
      const [row] = await db
        .select({ uploadGroup: attachments.uploadGroup })
        .from(attachments)
        .where(eq(attachments.id, id));
      return row.uploadGroup;
    };
    expect(await groupOf(response)).toBe(await groupOf(groupless));
  });

  /*
   * WHAT THE COMPOSER IS OWED WHEN THE STORE IS THE THING THAT FAILED.
   *
   * `app/src/components/channels/composer/attachments.ts` reads `{ error }` off every failed upload
   * and falls back to a generic `Could not upload "<name>"` when the body will not parse as JSON.
   * There is no `app.onError` behind this router — the `formData()` guard above says so, and relies
   * on it — so an unguarded database call meant a lost connection, a pool with nothing left, a
   * `statement_timeout`, a full disk and a lock timeout were all Hono's plain-text
   * `Internal Server Error`, and none of them were written down on this side either.
   */
  test("a database that cannot be reached refuses the upload as JSON, and says so in the log", async () => {
    const { channelId, memberId, member } = await harness();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelAttachmentRoutes(unreachableDatabase, member));

    const { result: response, logged } = await withCapturedErrorLog(() =>
      upload(
        app,
        channelId,
        new File([new TextEncoder().encode("abc")], "notes.txt", {
          type: "text/plain",
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(((await response.json()) as { error: string }).error).toContain(
      "Try again",
    );
    // Named, because an operator answering "why could nobody upload at 14:05" needs the person and
    // the channel, and a line naming neither cannot be acted on.
    expect(
      logged.some(
        (line) => line.includes(memberId) && line.includes(channelId),
      ),
    ).toBe(true);
  });

  /*
   * The same guarantee one statement deeper. The unreachable database above never gets past the
   * membership check, so this one lets every real statement through and fails only where the file
   * is actually written — which is the line a pool exhaustion, a lock timeout on
   * `pg_advisory_xact_lock` or a `53100` full disk would land on.
   */
  test("a transaction that cannot be opened refuses the upload as JSON, naming the size", async () => {
    const { channelId, member, database: db } = await harness();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createChannelAttachmentRoutes(databaseWhoseTransactionFails(db), member),
    );

    const { result: response, logged } = await withCapturedErrorLog(() =>
      upload(
        app,
        channelId,
        new File([new TextEncoder().encode("abcde")], "notes.txt", {
          type: "text/plain",
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(((await response.json()) as { error: string }).error).toContain(
      "Try again",
    );
    // The sniffed type and the size are in the line because "the disk is full" and "one 8 MiB
    // upload is being retried in a loop" look identical without them.
    expect(logged.some((line) => line.includes("text/plain"))).toBe(true);
    expect(logged.some((line) => line.includes("5 bytes"))).toBe(true);
  });
  /*
   * A REFUSAL THAT NAMES A NUMBER BELOW THE LIMIT IS A REFUSAL THAT CONTRADICTS ITSELF.
   *
   * The cap's count and its explanation used to be two statements. Both ran inside the upload's
   * transaction, but READ COMMITTED gives each statement its own snapshot and the advisory lock
   * does not cover withdrawals, so one `DELETE /api/attachments/:id` committing in between made the
   * 409 read "you already have 7 attachments waiting" while the limit is 8 — and a composer
   * dropping a whole queued message made it read 0. The upload was still right to refuse; only its
   * account of itself was wrong, and "you have 0 attachments, so you may not add one" is a sentence
   * no support conversation can recover from.
   *
   * The assertion is deliberately about NUMBERS rather than about the wording, so it keeps holding
   * if the sentence is rewritten again: no number this refusal prints may be below the limit that
   * produced it.
   */
  test("the cap's refusal never names a count below the limit, even when a withdrawal lands mid-request", async () => {
    const { app, channelId, database: db, member } = await harness();
    const uploadGroup = randomUUID();

    const staged: string[] = [];
    for (let index = 0; index < MAX_ATTACHMENTS_PER_MESSAGE; index++) {
      const response = await upload(
        app,
        channelId,
        new File([new TextEncoder().encode("abc")], `staged-${index}.txt`, {
          type: "text/plain",
        }),
        uploadGroup,
      );
      expect(response.status).toBe(201);
      staged.push(((await response.json()) as { id: string }).id);
    }

    // A real withdrawal through the real route, on its own connection, committing while the ninth
    // upload is between its statements.
    const withdrawer = attachmentApp(db, member);
    const racing = new Hono<{ Variables: AppVariables }>();
    racing.route(
      "/",
      createChannelAttachmentRoutes(
        databaseWithdrawingAfterTheInsert(db, async () => {
          const withdrawn = await withdrawer.request(
            `http://test/${staged[0]}`,
            { method: "DELETE" },
          );
          expect(withdrawn.status).toBe(204);
        }),
        member,
      ),
    );

    const ninth = await upload(
      racing,
      channelId,
      new File([new TextEncoder().encode("abc")], "ninth.txt", {
        type: "text/plain",
      }),
      uploadGroup,
    );

    expect(ninth.status).toBe(409);
    const { error } = (await ninth.json()) as { error: string };
    const counts = [...error.matchAll(/\d+/g)].map((match) => Number(match[0]));
    expect(counts.length).toBeGreaterThan(0);
    expect(
      counts.filter((count) => count < MAX_ATTACHMENTS_PER_MESSAGE),
    ).toEqual([]);
    // The withdrawal really did land, so the refusal above was explained against a table that had
    // already moved on: seven rows are left where the count says eight.
    const remaining = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.channelId, channelId),
          eq(attachments.uploadGroup, uploadGroup),
        ),
      );
    expect(remaining).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE - 1);
  });
  /*
   * A NAME THAT CANNOT BE PUT IN A HEADER IS A FILE NOBODY CAN FETCH.
   *
   * The fetch route echoes the stored name into `Content-Disposition` twice — quoted, and
   * percent-encoded for `filename*` — so a non-ASCII name comes back about four times its own
   * length. Measured through these two routes before the bound: a 4000-character name uploaded
   * fine and then served a 32 KB `Content-Disposition`. Bun serves it; a reverse proxy capping
   * response headers at 4-8 KB does not, and behind one that row is unfetchable for ever with
   * nothing in the app to say why.
   *
   * The upload is not refused over it — a name is a property of a file this app CAN read, and the
   * 201 hands back what was actually stored — so the assertions are that the file arrives, that the
   * name came back cut, and that the header it produces is small enough to survive a proxy.
   */
  test("a filename too long for a response header is cut rather than refused", async () => {
    const { app, channelId, database: db, member } = await harness();
    // Multi-byte on purpose: it is the percent-encoded copy that blows the header up, and an
    // ASCII-only name would not show it.
    const name = `${"é".repeat(4000)}.txt`;

    const uploaded = await upload(
      app,
      channelId,
      new File([new TextEncoder().encode("hello")], name, {
        type: "text/plain",
      }),
    );

    expect(uploaded.status).toBe(201);
    const stored = (await uploaded.json()) as { id: string; name: string };
    expect(stored.name.length).toBeLessThan(name.length);
    expect(new TextEncoder().encode(stored.name).length).toBeLessThanOrEqual(
      255,
    );
    // Never through the middle of a character: a cut that split one would leave a lone surrogate or
    // a replacement character rather than the "é" that was there.
    expect(stored.name).toBe("é".repeat(stored.name.length));

    const served = await attachmentApp(db, member).request(
      `http://test/${stored.id}`,
    );
    const disposition = served.headers.get("Content-Disposition") ?? "";
    expect(served.status).toBe(200);
    expect(new TextEncoder().encode(disposition).length).toBeLessThan(2_000);
  });

  /*
   * A REFUSAL WITH NOTHING TO NAME MUST NOT PRINT AN EMPTY PAIR OF BRACKETS.
   *
   * `sniffMimeType` hands the claim back when the bytes corroborate nothing and the claim names no
   * format, and the refusal interpolated it: `'archive' is not a file type this app can read ().`
   * The composer shows that sentence verbatim, so it is the only explanation anybody gets, and an
   * empty parenthetical is worse than the generic sentence it replaced.
   *
   * REACHED THROUGH THE FILENAME. Measured against this deployment's Bun: the multipart parser
   * ignores a part's own `Content-Type` header and derives `File.type` from the filename extension
   * (`photo.png` declared `text/plain` arrives as `image/png`), so a name with no extension is how
   * a blank claim gets here — the `type` passed to the `File` below is not what the route sees.
   */
  test("a refusal with no type to name does not print an empty parenthetical", async () => {
    const { app, channelId } = await harness();
    // No extension, and bytes that are neither valid UTF-8 nor any image signature: between them
    // the sniffer has nothing at all to report.
    const file = new File([new Uint8Array([0xff, 0xfe, 0xff])], "archive", {
      type: "application/octet-stream",
    });

    const response = await upload(app, channelId, file);

    expect(response.status).toBe(415);
    const { error } = (await response.json()) as { error: string };
    expect(error).toBe("'archive' is not a file type this app can read.");
  });
});

describe("GET /:id", () => {
  test("a member gets the bytes back byte-for-byte", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0x00]);
    const id = await uploadBytes(db, {
      channelId,
      uploadedBy: memberId,
      name: "blob.bin",
      mimeType: "application/octet-stream",
      bytes,
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(Buffer.compare(body, Buffer.from(bytes))).toBe(0);
  });

  /*
   * THE ONLY FAULT IN THIS FILE THAT SERVING THE RIGHT BYTES DOES NOT RULE OUT.
   *
   * `Uint8Array.from(row.bytes)` and a view over the same buffer produce identical responses, so
   * every other assertion here passes either way. What separates them is the process: `.from`
   * finds `@@iterator` on the `Buffer` and walks the file element by element, 8.4 million steps of
   * synchronous work for a file at the ceiling, during which this process answers nobody —
   * measured at 62-87ms for the conversion alone and 120-140ms for the whole fetch, against 36-38ms
   * once it became a view.
   *
   * So the assertion is about the EVENT LOOP rather than about the body: a 1ms interval samples
   * how long the thread went unavailable while the request ran. The threshold is 40ms against a
   * measured 62-87ms fault and a measured sub-millisecond healthy path — roughly half the fault
   * and a wide multiple of the healthy case, which is the margin that keeps a loaded machine or a
   * garbage collection from failing this while still catching a return to the iterator path.
   *
   * `MAX_IMAGE_BYTES` and not something smaller, because the cost is linear in the file and the
   * ceiling is the size this route is documented to serve.
   */
  test("serving an attachment at the size ceiling does not block the event loop", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    // A real PNG signature, so the route classifies this the way a photo at the ceiling would be.
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const id = await uploadBytes(db, {
      channelId,
      uploadedBy: memberId,
      name: "huge.png",
      mimeType: "image/png",
      bytes,
    });
    const app = attachmentApp(db, member);
    // Warmed, so the first request's own module and pool costs are not counted as a stall.
    expect((await app.request(`http://test/${id}`)).status).toBe(200);

    let longestPause = 0;
    let previousTick = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      longestPause = Math.max(longestPause, now - previousTick);
      previousTick = now;
    }, 1);
    let response: Response;
    try {
      previousTick = performance.now();
      response = await app.request(`http://test/${id}`);
      /*
       * ONE TURN OF THE LOOP BEFORE THE SAMPLER IS TAKEN AWAY, and without it this test cannot
       * fail. A timer is a macrotask and an awaited promise resumes on the microtask queue, so the
       * line above continues BEFORE the interval that would observe the stall gets to run: clearing
       * the sampler here measured 2.5ms against a fault that really did block for 62-87ms. The
       * gap that spans the blocked stretch is recorded by the first tick after it, so that tick
       * has to be allowed to happen.
       */
      await new Promise((resume) => setTimeout(resume, 5));
    } finally {
      clearInterval(sampler);
    }

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(MAX_IMAGE_BYTES);
    // Compared as a sentence rather than with `toBeLessThan`, so a failure names the pause it
    // measured: "62ms" against "under 40ms" says which fault came back, where "false is not true"
    // would leave the next person to re-measure it.
    expect(
      longestPause < 40 ? "under 40ms" : `${Math.round(longestPause)}ms`,
    ).toBe("under 40ms");
  }, 30_000);

  /*
   * A STAGED FILE HAS BEEN SHARED WITH NOBODY.
   *
   * Membership is what lets people see each other's SENT files. A row with no `attachedAt` is a
   * draft somebody has not sent — possibly one they are about to think better of — so serving it to
   * a colleague on the strength of the same channel join was the read side quietly disagreeing with
   * the write side, which refuses that same colleague any say over the row at all.
   *
   * Both halves are asserted in one test on purpose: "staged is private" is only correct if "sent
   * is shared" still holds, and a test that pinned the first alone could be satisfied by refusing
   * everybody everything.
   */
  test("a member cannot fetch a colleague's staged draft, and can once it is sent", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const colleagueId = `${testPrefix}-colleague-${randomUUID()}`;
    await db
      .insert(users)
      .values({ id: colleagueId, email: `${colleagueId}@example.test` });
    createdUserIds.push(colleagueId);
    await db
      .insert(channelMemberships)
      .values({ channelId, userId: colleagueId });
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });
    const colleague = attachmentApp(db, actorMiddleware(colleagueId));

    expect((await colleague.request(`http://test/${id}`)).status).toBe(404);

    // The uploader is not shut out of their own composer's preview by this.
    const uploader = attachmentApp(db, actorMiddleware(memberId));
    expect((await uploader.request(`http://test/${id}`)).status).toBe(200);

    await markAttachmentsSent(db, { actorId: memberId, threadId }, [id]);

    expect((await colleague.request(`http://test/${id}`)).status).toBe(200);
  });

  /*
   * The revalidation has to be decided on the same rule as the fetch, or a colleague holding a
   * staged id from before the send keeps a 304 that says "your copy is still good" for a file this
   * route would no longer hand them.
   */
  test("a colleague's staged draft is not revalidated into a 304 either", async () => {
    const { database: db, channelId, memberId } = await harness();
    const colleagueId = `${testPrefix}-colleague-${randomUUID()}`;
    await db
      .insert(users)
      .values({ id: colleagueId, email: `${colleagueId}@example.test` });
    createdUserIds.push(colleagueId);
    await db
      .insert(channelMemberships)
      .values({ channelId, userId: colleagueId });
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });

    const response = await attachmentApp(
      db,
      actorMiddleware(colleagueId),
    ).request(`http://test/${id}`, {
      headers: { "If-None-Match": `"${id}"` },
    });

    expect(response.status).toBe(404);
  });

  test("a non-member is refused with a 404, not a 403", async () => {
    const { database: db, channelId, memberId, stranger } = await harness();
    const id = await uploadBytes(db, {
      channelId,
      uploadedBy: memberId,
      name: "secret.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("shh"),
    });
    const app = attachmentApp(db, stranger);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(404);
  });

  /*
   * Channels soft-delete, so "deleted" is a column and not a missing row, and every read has to
   * say so itself. The upload route always did: its join leads with `channels` and
   * `deleted_at is null`. This one joined the membership alone — and a membership outlives its
   * channel's deletion, so the bytes stayed downloadable, and inlinable, for ever after the channel
   * they were uploaded into was deleted.
   */
  test("an attachment in a soft-deleted channel is no longer fetchable", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });
    const app = attachmentApp(db, member);
    // Fetchable first, so the 404 below is the deletion and not a broken fixture.
    expect((await app.request(`http://test/${id}`)).status).toBe(200);

    await db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));

    const response = await app.request(`http://test/${id}`);

    // 404, the same answer as "no such attachment" and as "not yours": whether a channel has been
    // deleted is not a bit to be read back off this route either.
    expect(response.status).toBe(404);
  });

  test("an image is served with its own Content-Type, nosniff, and inline", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const id = await uploadBytes(db, {
      channelId,
      uploadedBy: memberId,
      name: "photo.png",
      mimeType: "image/png",
      bytes: png,
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  /*
   * A DELETION HAS TO BE VISIBLE, and `private, max-age=3600` made it invisible.
   *
   * Deleting the row does make this route answer 404 — and the browser never asked. An `<img>`
   * already on the page kept painting the file from its own cache, at full natural width, for the
   * rest of the hour, so the "this attachment is unavailable" path the transcript has could not be
   * reached at all. The same hour kept the bytes readable after a sign-out and after a removal from
   * the channel.
   *
   * `no-cache` is not `no-store`: the copy is still kept, it just may not be used without asking
   * first. The bytes behind an id never change, so what is being kept fresh here is EXISTENCE, not
   * content — and the ETag below is what keeps the re-ask cheap.
   */
  test("the fetch response cannot be reused without revalidating", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(200);
    // `private` still, so no proxy or CDN in between may hold somebody's private file.
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("Cache-Control")).not.toContain("max-age");
    expect(response.headers.get("ETag")).toBe(`"${id}"`);
  });

  /*
   * The revalidation itself, on both sides of a deletion. A 304 is what makes `no-cache` affordable
   * — the bytes do not go back over the wire — and the 404 after is the point of asking at all: the
   * question the conditional request answers is whether the file is still THERE and still THEIRS,
   * and it is re-asked against this actor's membership every single time.
   */
  test("a revalidation is answered 304 while the row lives and 404 once it is gone", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });
    const app = attachmentApp(db, member);

    const revalidate = () =>
      app.request(`http://test/${id}`, {
        headers: { "If-None-Match": `"${id}"` },
      });

    const fresh = await revalidate();
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
    expect(fresh.headers.get("Cache-Control")).toBe("private, no-cache");

    await db.delete(attachments).where(eq(attachments.id, id));

    expect((await revalidate()).status).toBe(404);
  });

  /*
   * A 304 SENDS NO BODY, SO IT MUST NOT READ ONE.
   *
   * `ATTACHMENT_CACHE_CONTROL` is `private, no-cache` deliberately, which means every image paint in
   * every viewing member's transcript revalidates through this route — the 304 is the common answer
   * here, not the rare one. It was nevertheless served by selecting `bytes` and then discarding
   * them: measured through this route against an 8 MiB attachment, 8,388,608 bytes read and 25.09ms
   * median per 304.
   *
   * The column list is the fact, for the same reason the HEAD probe's test gives: an empty body is
   * an empty body either way, and a stopwatch is a guess about how fast this machine is. `bytes` is
   * either in the statement or it is not.
   *
   * Both halves in one test, as with the probe: "the revalidation does not read the file" is only
   * the right property if "the fetch still does" holds, and a recorder that saw `bytes` nowhere
   * would satisfy the first assertion while the route served nothing at all.
   */
  test("a revalidation does not read the file it is not going to send", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });

    const revalidated: string[][] = [];
    const revalidating = attachmentApp(
      databaseRecordingSelections(db, revalidated),
      member,
    );
    const notModified = await revalidating.request(`http://test/${id}`, {
      headers: { "If-None-Match": `"${id}"` },
    });

    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(revalidated.flat()).not.toContain("bytes");

    // And the same request without the header does read them, so the assertion above is about this
    // handler rather than about how the recorder happens to see drizzle.
    const fetched: string[][] = [];
    const fetcher = attachmentApp(
      databaseRecordingSelections(db, fetched),
      member,
    );
    expect((await fetcher.request(`http://test/${id}`)).status).toBe(200);
    expect(fetched.flat()).toContain("bytes");
  });

  /*
   * The saving above may not be bought with the access check. A revalidation asks "is this still
   * there and still mine", so it is the one answer on this route that MUST be re-decided against the
   * live channel and this actor's membership every single time — dropping `bytes` from the select
   * list must not drop the join that earns the 304.
   *
   * A stranger revalidating with a valid ETag is the case that would show it: if the ETag alone
   * decided, they would be told their copy is still good for a file they may not read.
   */
  test("a stranger's revalidation is refused rather than answered from the ETag", async () => {
    const {
      database: db,
      channelId,
      memberId,
      member,
      stranger,
    } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
      attachedAt: new Date(),
    });
    const conditional = { headers: { "If-None-Match": `"${id}"` } };

    // The member holds a good copy, so their revalidation is the 304 this is measured against.
    expect(
      (
        await attachmentApp(db, member).request(
          `http://test/${id}`,
          conditional,
        )
      ).status,
    ).toBe(304);

    expect(
      (
        await attachmentApp(db, stranger).request(
          `http://test/${id}`,
          conditional,
        )
      ).status,
    ).toBe(404);

    // And once the channel is gone the member's own revalidation goes the same way, which is the
    // other half of what the join is there for.
    await db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));
    expect(
      (
        await attachmentApp(db, member).request(
          `http://test/${id}`,
          conditional,
        )
      ).status,
    ).toBe(404);
  });

  test("a text file is served attachment, never inline", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).not.toBe("inline");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain('filename="notes.txt"');
  });

  test("a non-Latin-1 filename is served instead of 500ing, folded in the quoted param and intact in filename*", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "メモ.txt",
      text: "hello",
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(200);
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain('filename="__.txt"');
    expect(disposition).toContain("filename*=UTF-8''%E3%83%A1%E3%83%A2.txt");
  });

  test("a filename carrying C0 control characters is served with none of them in the header", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      // A vertical tab and a DEL. Neither can appear in an HTTP field value, and neither is one of
      // the CR/LF pair the escaping used to take out, so between them they stand for the whole
      // rest of that class.
      name: "report\u000B\u007F.txt",
      text: "hello",
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`);

    expect(response.status).toBe(200);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain('filename="report__.txt"');
    // Percent-encoding turns a control character into something a header CAN carry (`%0B`), so the
    // extended parameter is checked for the folded name rather than merely for header-safety.
    expect(disposition).toContain("filename*=UTF-8''report__.txt");
    expect(controlCharactersIn(disposition)).toEqual([]);
  });

  test("an SVG body uploaded as text/plain is stored, and served so it cannot run", async () => {
    // A known and deliberate limit of `sniffMimeType`: an SVG is valid UTF-8,
    // so a text claim over SVG bytes is corroborated and accepted. No
    // "does this look like XML" sniff is attempted, because that is brittle
    // and would refuse legitimate text. What makes it safe is not the sniff
    // but this response, so the response is what gets pinned: the stored type
    // is served verbatim (`text/plain`, never `image/svg+xml`), `nosniff`
    // stops the browser upgrading that guess for itself, and the disposition
    // is `attachment`, so nothing renders in a document on this origin. Any
    // one of the three would do; all three have to hold.
    const { app, channelId, database: db, member } = await harness();
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";

    const uploaded = await upload(
      app,
      channelId,
      new File([svg], "notes.txt", { type: "text/plain" }),
    );
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };

    const served = await attachmentApp(db, member).request(`http://test/${id}`);

    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("text/plain");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(served.headers.get("Content-Disposition")).toContain("attachment");
    expect(served.headers.get("Content-Disposition")).not.toBe("inline");
  });

  test("a non-UUID id is refused with a 404, not a 500", async () => {
    const { database: db, member } = await harness();
    const app = attachmentApp(db, member);

    const response = await app.request("http://test/not-a-uuid");

    expect(response.status).toBe(404);
  });
  /*
   * WHAT THE TRANSCRIPT'S DOCUMENT PROBE COSTS.
   *
   * Hono answers HEAD by running the GET handler and dropping the body, and the transcript probes
   * every document tile it draws with `HEAD /api/attachments/<id>` from every viewing member's
   * browser — with `no-cache`, on every mount. Before the dedicated handler that was a full `bytea`
   * read per tile per mount, for bytes nobody would be sent.
   *
   * Asserted on the SQL rather than on a stopwatch: the fetch asks for `bytes`, and the probe must
   * not.
   */
  test("a HEAD answers from the metadata alone, without reading the file", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const bytes = new Uint8Array(64 * 1024).fill(7);
    const id = await uploadBytes(db, {
      channelId,
      uploadedBy: memberId,
      name: "report.pdf",
      mimeType: "text/plain",
      bytes,
      attachedAt: new Date(),
    });

    const probed: string[][] = [];
    const probe = attachmentApp(
      databaseRecordingSelections(db, probed),
      member,
    );
    const head = await probe.request(`http://test/${id}`, { method: "HEAD" });

    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    // The size a probe is usually asking for, which a body-less response cannot imply.
    expect(head.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(probed.flat()).not.toContain("bytes");

    // And the fetch of the same row does read them, so the assertion above is about this handler
    // rather than about how the recorder happens to see drizzle.
    const fetched: string[][] = [];
    const fetcher = attachmentApp(
      databaseRecordingSelections(db, fetched),
      member,
    );
    expect((await fetcher.request(`http://test/${id}`)).status).toBe(200);
    expect(fetched.flat()).toContain("bytes");
  });

  /*
   * A PROBE MAY NOT ANSWER A QUESTION THE FETCH WOULD REFUSE.
   *
   * The HEAD handler repeats the GET's guards rather than sharing them, so the risk it carries is
   * drift: a rule added to one and not the other turns HEAD into a way to learn that an id exists,
   * or that a colleague has a draft, which the GET's uniform 404 exists to hide. Every refusal is
   * therefore compared against the GET's own answer for the same request.
   */
  test("a HEAD answers exactly what a GET would, for every refusal", async () => {
    const {
      database: db,
      channelId,
      memberId,
      member,
      stranger,
    } = await harness();
    const colleagueId = `${testPrefix}-colleague-${randomUUID()}`;
    await db
      .insert(users)
      .values({ id: colleagueId, email: `${colleagueId}@example.test` });
    createdUserIds.push(colleagueId);
    await db
      .insert(channelMemberships)
      .values({ channelId, userId: colleagueId });

    const sent = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "hello",
      attachedAt: new Date(),
    });
    const staged = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });

    const cases: {
      name: string;
      app: Hono<{ Variables: AppVariables }>;
      path: string;
    }[] = [
      {
        name: "a sent file, to a member",
        app: attachmentApp(db, member),
        path: sent,
      },
      {
        name: "a colleague's staged draft",
        app: attachmentApp(db, actorMiddleware(colleagueId)),
        path: staged,
      },
      {
        name: "a stranger to the channel",
        app: attachmentApp(db, stranger),
        path: sent,
      },
      {
        name: "an id that names no row",
        app: attachmentApp(db, member),
        path: randomUUID(),
      },
      {
        name: "an id no uuid column could hold",
        app: attachmentApp(db, member),
        path: "not-a-uuid",
      },
    ];

    /*
     * THE STATUS IS NOT THE WHOLE ANSWER, WHICH IS HOW ONE OF THESE DRIFTED. Hono answers a HEAD by
     * dispatching the GET handler and re-wrapping the result as `new Response(null, <it>)`: the body
     * is dropped but every header survives. So a refusal built with `context.body(null, status)`
     * carries no `Content-Type` where the fetch's `context.json` carries `application/json`, and the
     * two are distinguishable to anybody probing — for a 503 that was exactly the case, measured at
     * `503 application/json` from the GET against a bare `503` from the HEAD. Comparing the pair
     * rather than the number is what would have caught it.
     */
    const shapeOf = (response: Response) => ({
      status: response.status,
      contentType: response.headers.get("Content-Type"),
    });

    for (const { name, app, path } of cases) {
      const fetched = await app.request(`http://test/${path}`);
      const probed = await app.request(`http://test/${path}`, {
        method: "HEAD",
      });
      expect({ [name]: shapeOf(probed) }).toEqual({
        [name]: shapeOf(fetched),
      });
    }
  });

  /*
   * The refusal the loop above cannot reach, because it needs a database that is not there.
   *
   * A 503 is the one answer on this route that is about this side rather than about the asker, and
   * it was the one the probe spelled differently: `context.body(null, 503)` against the fetch's
   * `context.json`. Both now go through the same expression, so there is no second spelling left to
   * drift — and the log line is asserted too, because a fault nobody can see from outside is half of
   * what the 503 exists to report.
   */
  test("a HEAD and a GET refuse an unreachable database in the same shape", async () => {
    const memberId = `${testPrefix}-member-${randomUUID()}`;
    const app = attachmentApp(unreachableDatabase, actorMiddleware(memberId));
    const id = randomUUID();

    const { result, logged } = await withCapturedErrorLog(async () => ({
      fetched: await app.request(`http://test/${id}`),
      probed: await app.request(`http://test/${id}`, { method: "HEAD" }),
    }));

    expect(result.fetched.status).toBe(503);
    // Not a 404: the transcript paints "this attachment is gone" on one of those, and a lost
    // connection is not a withdrawal.
    expect(result.probed.status).toBe(503);
    expect(result.probed.headers.get("Content-Type")).toBe(
      result.fetched.headers.get("Content-Type"),
    );
    expect(result.fetched.headers.get("Content-Type")).toContain(
      "application/json",
    );
    expect((await result.fetched.json()) as { error: string }).toEqual({
      error: "That attachment could not be read just now. Try again.",
    });
    // Both reads are written down, naming the row and the asker, because that is what it would take
    // to act on either.
    expect(logged.filter((line) => line.includes(id))).toHaveLength(2);
    expect(logged.every((line) => line.includes(memberId))).toBe(true);
  });

  /*
   * The same question for the answer the probe and the fetch share outright. A revalidation is
   * handled before the method is even looked at now, so a HEAD and a GET carrying the same
   * `If-None-Match` differ in nothing at all — which is what the two used to only claim.
   */
  test("a HEAD and a GET revalidate into the same 304", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "hello",
      attachedAt: new Date(),
    });
    const app = attachmentApp(db, member);
    const conditional = { headers: { "If-None-Match": `"${id}"` } };

    const fetched = await app.request(`http://test/${id}`, conditional);
    const probed = await app.request(`http://test/${id}`, {
      ...conditional,
      method: "HEAD",
    });

    for (const response of [fetched, probed]) {
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(`"${id}"`);
      expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    }
  });

  /*
   * The probe revalidates on the same terms as the fetch, or a client holding a stale id would be
   * told its copy is still good by one and that the file is gone by the other.
   */
  test("a HEAD honours If-None-Match, and stops doing so once the row is gone", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "hello",
      attachedAt: new Date(),
    });
    const app = attachmentApp(db, member);

    const held = await app.request(`http://test/${id}`, {
      method: "HEAD",
      headers: { "If-None-Match": `"${id}"` },
    });
    expect(held.status).toBe(304);

    await db.delete(attachments).where(eq(attachments.id, id));

    const gone = await app.request(`http://test/${id}`, {
      method: "HEAD",
      headers: { "If-None-Match": `"${id}"` },
    });
    expect(gone.status).toBe(404);
  });
});

describe("DELETE /:id", () => {
  test("a staged attachment can be deleted by its uploader, then 404s on GET", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });
    const app = attachmentApp(db, member);

    const deleteResponse = await app.request(`http://test/${id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    const getResponse = await app.request(`http://test/${id}`);
    expect(getResponse.status).toBe(404);
  });

  test("a sent attachment cannot be deleted", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "already in a message",
      attachedAt: new Date(),
    });
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
  });

  /*
   * THE QUERY THAT EXPLAINS THE REFUSAL ASKS ONLY WHETHER THERE IS A ROW.
   *
   * It used to select `attachedAt` and never read it: the 409 below it is unconditional. A column
   * fetched and dropped is cheap, but a column fetched and dropped in a query that decides between a
   * 404 and a 409 reads as a check being made, and no check was. The next person to touch this would
   * have had to work out from scratch that the decision comes from the two WHEREs — this query
   * repeating every term of the delete's except `attached_at is null`, so a row coming back means
   * that term is the one that refused.
   *
   * Pinned on the column list rather than on the status, because the status was already right. What
   * changed is that the statement now says what it is for.
   */
  test("the refused withdrawal's explanation reads no column it does not act on", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "already in a message",
      attachedAt: new Date(),
    });

    const selected: string[][] = [];
    const app = attachmentApp(
      databaseRecordingSelections(db, selected),
      member,
    );
    const response = await app.request(`http://test/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(selected.flat()).not.toContain("attachedAt");
    // The 409 is still the one it was, said the one way it is said.
    expect((await response.json()) as { error: string }).toEqual({
      error: "This attachment is already part of a sent message.",
    });
  });

  /*
   * The same refusal, when the send lands DURING the request rather than before it.
   *
   * The route used to read `attachedAt`, decide on what it read, and then delete by id alone. Those
   * are two statements, and a send is one more: stamp the row between them and the delete removed a
   * file a sent message already pointed at, because its WHERE no longer mentioned the column the
   * decision was made on. The window is small and entirely real — the sender's own turn writes that
   * stamp while their composer may still be offering the file for withdrawal.
   *
   * Held open on purpose here rather than hoped for. An uncommitted UPDATE takes the row lock; a
   * plain SELECT reads straight past it on the old snapshot, which is exactly why the check saw a
   * staged row; and the DELETE has to wait. What it does when it stops waiting is the whole test:
   * Postgres re-checks the delete's WHERE against the row as it now stands, so a WHERE that carries
   * `attached_at IS NULL` matches nothing and a WHERE that does not still removes the file.
   */
  test(
    "a send landing mid-request cannot have its file deleted out from under it",
    async () => {
      const { database: db, channelId, memberId, member } = await harness();
      const id = await uploadText(db, {
        channelId,
        uploadedBy: memberId,
        name: "draft.txt",
        text: "about to be sent",
      });

      /*
       * One more connection, named, so `pg_blocking_pids` can point at the request's own session
       * rather than at whatever else is talking to this database.
       *
       * `{ max: 1 }` rather than `TEST_POOL`, and the difference is not tidiness. Every file that
       * opens a pool holds it for the whole run, the suite already sits within sight of PostgreSQL's
       * hundred, and a second one here took it over: the failure is `53300 sorry, too many clients
       * already` in whichever unrelated file happened to connect next. The request below issues its
       * statements one after another, so one connection is all it can use anyway. The blocking
       * transaction and the `pg_blocking_pids` poll take the shared pool's two.
       */
      const applicationName = `attachment_delete_race_${randomUUID()}`;
      const namedUrl = new URL(databaseUrl);
      namedUrl.searchParams.set("application_name", applicationName);
      const namedDatabase = createDatabase(namedUrl.toString(), { max: 1 });

      const stampWritten = deferred();
      const releaseSend = deferred();
      const send = db.transaction(async (transaction) => {
        await transaction
          .update(attachments)
          .set({ attachedAt: new Date() })
          .where(eq(attachments.id, id));
        stampWritten.resolve();
        await releaseSend.promise;
      });
      void send.catch(stampWritten.reject);

      let status: number | undefined;
      try {
        await stampWritten.promise;
        const app = attachmentApp(namedDatabase, member);
        let settled = false;
        const withdrawal = app
          .request(`http://test/${id}`, { method: "DELETE" })
          .then(
            (value) => {
              settled = true;
              return value;
            },
            (reason: unknown) => {
              settled = true;
              throw reason;
            },
          );

        expect(
          await waitForBlockedSession(applicationName, () => settled),
        ).toBe(true);
        releaseSend.resolve();
        await send;
        status = (await withdrawal).status;
      } finally {
        releaseSend.resolve();
        await send.catch(() => undefined);
        await namedDatabase.$client.close();
      }

      expect(status).toBe(409);
      // The row itself, because a 409 that answered after the file was already gone would be the same
      // failure wearing the right status code.
      expect(await attachedAtOf(db, id)).toBeInstanceOf(Date);
      // As above: the runner's default 5s timeout used to kill this before the helper could say which
      // session it had been watching. See BLOCKED_SESSION_TIMEOUT_MS.
    },
    BLOCKED_SESSION_TIMEOUT_MS,
  );

  test("a second channel member cannot delete another member's staged draft", async () => {
    const { database: db, channelId, memberId } = await harness();
    const otherMemberId = `${testPrefix}-other-${randomUUID()}`;
    await db.insert(users).values({
      id: otherMemberId,
      email: `${otherMemberId}@example.test`,
    });
    createdUserIds.push(otherMemberId);
    await db
      .insert(channelMemberships)
      .values({ channelId, userId: otherMemberId });
    const otherMember = actorMiddleware(otherMemberId);

    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });
    const app = attachmentApp(db, otherMember);

    const response = await app.request(`http://test/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, id));
    expect(rows.length).toBe(1);
  });

  /*
   * Membership is an access-control boundary, and the withdrawal still stands on it.
   *
   * The conditional delete carries the whole rule — id, uploader, still-staged AND still a member —
   * because a statement that dropped the membership term would be a boundary quietly loosened
   * inside a change about when a column is written. The bytes are the person's own and the sweeper
   * would reclaim them anyway, so the harm is small; a boundary that erodes one low-harm case at a
   * time is the thing being refused here.
   *
   * 404, not 403, exactly as everywhere else in this router: a former member learns nothing about
   * whether the id still names anything.
   */
  test("somebody removed from the channel cannot withdraw their own staged draft", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });

    await db
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, memberId),
        ),
      );

    const app = attachmentApp(db, member);
    const response = await app.request(`http://test/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, id));
    expect(rows.length).toBe(1);
  });

  /*
   * The withdrawal stands on the same channel scope as the fetch. A membership row outlives the
   * soft deletion of its channel, so a delete scoped by membership alone still acted inside a
   * channel nobody can open any more. 404 rather than 204, exactly as everywhere else in this
   * router: nothing about the row is visible, including that it is still there.
   */
  test("a staged draft in a soft-deleted channel cannot be withdrawn", async () => {
    const { database: db, channelId, memberId, member } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });
    await db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));
    const app = attachmentApp(db, member);

    const response = await app.request(`http://test/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, id));
    expect(rows.length).toBe(1);
  });

  test("a non-UUID id is refused with a 404, not a 500", async () => {
    const { database: db, member } = await harness();
    const app = attachmentApp(db, member);

    const response = await app.request("http://test/not-a-uuid", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
  });
});

describe("attachment route composition", () => {
  test("mounts both routers behind createApp authentication with the derived actor", async () => {
    const { database: db, channelId, memberId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });

    let session: {
      user: { id: string; email: string; name: string; image: string };
    } | null = null;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => session },
      },
      { rolesForUser: async () => ["user"] },
      // Positions 4-25, ending at userInstructions. `attachmentDatabase` is position 26, the same
      // gap channel-routes.test.ts leaves for channelStore at position 11.
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
      db,
    );

    const unauthenticated = await app.request(
      `http://openbot.test/api/attachments/${id}`,
    );
    expect(unauthenticated.status).toBe(401);

    session = {
      user: {
        id: memberId,
        email: `${memberId}@example.test`,
        name: "OpenBot Member",
        image: "https://example.test/member.png",
      },
    };

    const authenticated = await app.request(
      `http://openbot.test/api/attachments/${id}`,
    );
    expect(authenticated.status).toBe(200);

    const uploadFormData = new FormData();
    uploadFormData.set(
      "file",
      // A real PNG signature, not three arbitrary bytes wearing the name: an
      // `image/png` claim the bytes do not corroborate is refused, so junk
      // here would 415 on the file rather than prove the route is mounted.
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "x.png",
        { type: "image/png" },
      ),
    );
    const uploadResponse = await app.request(
      `http://openbot.test/api/channels/${channelId}/attachments`,
      { method: "POST", body: uploadFormData },
    );
    expect(uploadResponse.status).toBe(201);
  });

  test("leaves both routers unmounted when createApp has no database", async () => {
    const app = createApp(loadConfig(testEnvironment()));

    const fetchResponse = await app.request(
      "http://openbot.test/api/attachments/not-a-uuid",
    );
    expect(fetchResponse.status).toBe(404);

    const uploadResponse = await app.request(
      "http://openbot.test/api/channels/some-channel/attachments",
      { method: "POST" },
    );
    expect(uploadResponse.status).toBe(404);
  });
});

/*
 * THIS TEST USED TO PIN THE BUG IT WAS MEANT TO GUARD.
 *
 * It posted `MAX_IMAGE_BYTES + 1` bytes and asserted, POSITIVELY, that the refusal was NOT JSON —
 * `expect(() => JSON.parse(text)).toThrow()` — using hono's plain-text `Payload Too Large` as the
 * way to tell the door's 413 from the handler's. Both halves of that premise were themselves
 * defects, and the door has since been fixed on both counts (`server/src/app.ts`).
 *
 * The size was wrong because the door measures THE ENVELOPE and every other gate measures THE FILE:
 * `bodyLimit` runs before anything has parsed the body, so the multipart boundary, the part headers
 * and the `uploadGroup` field (~360 bytes as the composer sends them) counted against the file's own
 * ceiling. A file at exactly the published 8MB limit was refused. The door now sits at
 * `UPLOAD_BODY_LIMIT_BYTES`, so `MAX_IMAGE_BYTES + 1` sails through it — and the handler is what
 * refuses that one, naming the file. This test's old size now reaches `requireUser` and answers 503.
 *
 * The shape was wrong because the composer reads `{ error }` off every failure
 * (`app/src/components/channels/composer/attachments.ts`) and falls back to a generic sentence when
 * the body will not parse — so on the one refusal whose reason is both knowable and actionable, the
 * person was told nothing. The door now answers JSON, which is what the assertion below requires.
 *
 * No assertion that lets a file at the ceiling through can also keep the old one: the two sizes
 * differ by one byte and the framing is ~360, so whatever the door's number is, `ceiling + 1` is on
 * the same side of it as the ceiling. The discriminator has to be something other than the shape of
 * the refusal, and it is: a body past the DOOR'S own ceiling can only have been refused by the door.
 */
describe("the upload route's body limit", () => {
  /** The app the two tests below share: no auth service, so nothing below the door can answer 2xx. */
  function appWithNoAuth(db: Database) {
    return createApp(
      loadConfig(testEnvironment()),
      // Positions 2-25: no auth needed, since the body limit runs ahead of every route below it,
      // including `requireUser`. `attachmentDatabase` is position 26.
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
      undefined,
      undefined,
      db,
    );
  }

  function postBytes(
    app: ReturnType<typeof createApp>,
    channelId: string,
    byteLength: number,
  ) {
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array(byteLength)], "huge.png", { type: "image/png" }),
    );
    return app.request(
      `http://openbot.test/api/channels/${channelId}/attachments`,
      { method: "POST", body: formData },
    );
  }

  test("a POST past the door's own ceiling is refused by the body limit, in a shape the composer can read", async () => {
    const { database: db, channelId } = await harness();
    const app = appWithNoAuth(db);

    const response = await postBytes(
      app,
      channelId,
      UPLOAD_BODY_LIMIT_BYTES + 1,
    );

    expect(response.status).toBe(413);
    // The refusal has to be `{ error }` or the composer shows "Could not upload ..." and the person
    // never learns that the file was simply too big.
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("8MB");
    // Scoped to this test's own channel: a global row count would collide with the sweeper test,
    // which deletes across the whole shared database.
    const rows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.channelId, channelId));
    expect(rows.length).toBe(0);
  });

  /*
   * What makes the 413 above the DOOR'S and not somebody else's.
   *
   * The app is built with no auth service, so every route beneath the middleware answers 503 — which
   * means a 413 cannot have come from below it. A small body to the very same URL proves the door is
   * not simply refusing everything: it answers 503, so size is the only thing that differs between
   * the two requests, and the door is the only thing that measures size before `requireUser`.
   */
  test("a small POST to the same URL is not refused by the door, so the 413 above is about size", async () => {
    const { database: db, channelId } = await harness();
    const app = appWithNoAuth(db);

    const response = await postBytes(app, channelId, 8);

    expect(response.status).not.toBe(413);
  });
});

/**
 * A SECOND channel belonging to the same person, with its own conversation.
 *
 * This is the production shape, not a contrivance: `makeChannel` gives every channel exactly one
 * membership row and exactly one mapping row, both for its creator, so one person with two channels
 * has two threads and is a member of both. That is all it takes to reach the cross-channel case —
 * no second person and no shared channel, which is why it survived three rounds of review looking
 * like somebody else's problem.
 */
async function secondChannelFor(
  db: Database,
  memberId: string,
): Promise<{ channelId: string; threadId: string }> {
  const channelId = `${testPrefix}-channel-${randomUUID()}`;
  await db.insert(channels).values({
    id: channelId,
    name: "The Other Channel",
    description: "A second conversation the same person is in.",
  });
  createdChannelIds.push(channelId);
  await db.insert(channelMemberships).values({ channelId, userId: memberId });
  const threadId = `${testPrefix}-thread-${randomUUID()}`;
  await db
    .insert(intelligenceChannelMappings)
    .values({ channelId, userId: memberId, threadId });
  return { channelId, threadId };
}

describe("loadAttachmentForTurn", () => {
  /*
   * THE CROSS-CHANNEL CASE, which is the one this scope exists for.
   *
   * The ids reach the loader out of browser-supplied message content, so a person in two channels
   * of their own can put an `/api/attachments/<id>` part for a file in A on a message they compose
   * in B. Membership alone says yes — they really are a member of A — and before the run's thread
   * was passed down, membership alone was the whole of the check.
   *
   * It is not a confidentiality break: they hold that file either way, and today a channel has
   * exactly one human member, so nobody else is even watching. What it leaves behind is a message
   * in B whose file belongs to a channel B has nothing to do with — so the day A is deleted, B's
   * transcript has an attachment that is permanently broken while the row is still sitting there,
   * and a re-run of that turn fails outright rather than degrading, because the message being asked
   * about is resolved with `onMissing: "fail"`.
   */
  test("a file from another channel of the same person's is not loaded into this turn", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const other = await secondChannelFor(db, memberId);

    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "budget.txt",
      text: "in the first channel",
      // Sent, so the staged-row rule is not what refuses it below and the channel term is.
      attachedAt: new Date(),
    });

    // Its own conversation still gets it, so the null below is the channel and not a broken fixture.
    expect(
      (await loadAttachmentForTurn(db, { actorId: memberId, threadId }, id))
        ?.name,
    ).toBe("budget.txt");

    expect(
      await loadAttachmentForTurn(
        db,
        { actorId: memberId, threadId: other.threadId },
        id,
      ),
    ).toBeNull();
  });

  /*
   * AND THE BRANCH THAT KEEPS HOPS WORKING, which is why the scope is not an inner join.
   *
   * Three surfaces run turns on threads this deployment deliberately keeps no channel for: a
   * forward agent hop (`handoff-delivery.ts` mints a scratch thread of the addressed Bot's own,
   * because an Intelligence thread has exactly one agent), the direct `/bot` chat (whose thread
   * comes from `POST /api/threads/mint` — "a conversation this deployment keeps no channel for"),
   * and a backwards hop relaying into either.
   *
   * The hop is the one that would have been broken silently. It seeds that scratch thread with the
   * ASKING channel's history, attachment parts and all, and history is resolved with
   * `onMissing: "note"` — so under an inner join the addressed Bot would have been told
   * `[attachment "x" is no longer available]` about files that exist and that the same person may
   * read, with nothing raised anywhere. A hop's last user message is the synthetic instruction
   * `handoff-delivery.ts` appends, so the "fail" branch that exists to catch a missing file never
   * covers a hop's history either.
   */
  test("a thread that maps to no channel still loads, so a hop keeps the history it was handed", async () => {
    const { database: db, channelId, memberId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "budget.txt",
      text: "asked about in the channel, answered on a scratch thread",
      attachedAt: new Date(),
    });

    const scratchThread = `${testPrefix}-scratch-${randomUUID()}`;

    expect(
      (
        await loadAttachmentForTurn(
          db,
          { actorId: memberId, threadId: scratchThread },
          id,
        )
      )?.name,
    ).toBe("budget.txt");
  });

  /*
   * The degrade is about the THREAD having no channel, not about the scope being optional. A
   * scratch thread does not become a skeleton key: everything the membership join and the staged
   * rule already refused is still refused on one.
   */
  test("an unmapped thread is not a way around membership", async () => {
    const { database: db, channelId, memberId, strangerId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "budget.txt",
      text: "not the stranger's",
      attachedAt: new Date(),
    });

    const scratchThread = `${testPrefix}-scratch-${randomUUID()}`;

    expect(
      await loadAttachmentForTurn(
        db,
        { actorId: strangerId, threadId: scratchThread },
        id,
      ),
    ).toBeNull();
  });

  test("a member's turn gets the bytes", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });

    const loaded = await loadAttachmentForTurn(
      db,
      { actorId: memberId, threadId },
      id,
    );

    expect(loaded?.name).toBe("notes.txt");
    expect(loaded?.mimeType).toBe("text/plain");
    expect(loaded?.bytes.toString("utf8")).toBe("hello");
  });

  /*
   * The hole this join closes. `input.messages` is the browser's, so a signed-in person can put an
   * `/api/attachments/<id>` part for somebody else's channel on a message they compose themselves —
   * no uuid guessing needed, because anybody removed from a channel still holds its ids in their
   * local transcript. The GET route already refuses this exact id with a 404; the turn path has to
   * refuse it too, or the bytes go straight to a model that reads them back to them.
   */
  test("a non-member's turn gets nothing, and the turn fails naming the id", async () => {
    const {
      database: db,
      channelId,
      memberId,
      strangerId,
      threadId,
    } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "private.txt",
      text: "not for you",
    });

    const loaded = await loadAttachmentForTurn(
      db,
      { actorId: strangerId, threadId },
      id,
    );
    expect(loaded).toBeNull();

    // Null is not a quiet skip: `resolveAttachmentParts` fails the whole turn on it rather than
    // letting the Bot answer as if the file were not there.
    await expect(
      resolveAttachmentParts(
        [
          {
            type: "image",
            source: { type: "url", value: attachmentUrl(id) },
          },
        ],
        (partId) =>
          loadAttachmentForTurn(db, { actorId: strangerId, threadId }, partId),
      ),
    ).rejects.toThrow(`Attachment "${id}" could not be loaded`);

    // And a refused load stamps nothing: the row is still staged as far as the sweeper is
    // concerned, because nobody entitled to it has been shown it.
    const [row] = await db
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, id));
    expect(row?.attachedAt).toBeNull();
  });

  /*
   * A READ IS NOT A SEND, and this is the property the whole meaning of `attachedAt` rests on.
   *
   * This function is called for the message being asked about AND for every attachment in the
   * history behind it, on every turn, by whoever is running that turn. Stamping here therefore said
   * "sent" about every file anybody had ever been shown — and three readers take that word
   * literally: the sweeper skips the row for ever, the upload cap frees the slot, and the
   * withdrawal route answers 409. The send is what writes the column now; see
   * `markAttachmentsSent`.
   */
  test("a load leaves attachedAt alone, however many turns replay it", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "hello",
    });

    // Twice, because history is replayed in full on every turn: the second read is the second turn.
    expect(
      (await loadAttachmentForTurn(db, { actorId: memberId, threadId }, id))
        ?.name,
    ).toBe("draft.txt");
    expect(
      (await loadAttachmentForTurn(db, { actorId: memberId, threadId }, id))
        ?.name,
    ).toBe("draft.txt");

    expect(await attachedAtOf(db, id)).toBeNull();
  });

  /*
   * The colleague's staged draft, and why reading it may not write to it.
   *
   * Reading is scoped to CHANNEL MEMBERSHIP, because members are meant to see each other's sent
   * files. So while the read did the stamping, any member could freeze a colleague's still-staged
   * row by naming its id in a message of their own — and a frozen row is not a cosmetic problem:
   * the colleague's own withdrawal answers 409 for ever, and the sweeper will never reclaim it
   * either, because both of them read `attachedAt` and it now says the file was sent.
   */
  test("a member who is not the uploader cannot stamp a colleague's staged row", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const otherMemberId = `${testPrefix}-other-${randomUUID()}`;
    await db.insert(users).values({
      id: otherMemberId,
      email: `${otherMemberId}@example.test`,
    });
    createdUserIds.push(otherMemberId);
    await db
      .insert(channelMemberships)
      .values({ channelId, userId: otherMemberId });

    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "draft.txt",
      text: "not sent yet",
    });

    /*
     * Both ways another member's turn touches this row, and both are refused while it is staged.
     * The write always was — that is what `uploadedBy` in the update's WHERE is for — and the read
     * now is too: a row with no `attachedAt` has been shared with nobody, so a colleague's
     * half-composed draft is not a channel's to read back to a model.
     */
    expect(
      await loadAttachmentForTurn(db, { actorId: otherMemberId, threadId }, id),
    ).toBeNull();
    /*
     * AND THE WRITE NOW SAYS SO OUT LOUD, where it used to decline quietly. The row is not this
     * person's to stamp and it is not recorded as sent by anybody, so the send cannot be recorded —
     * which is exactly the state the verification refuses over. The property this test is named for
     * is unchanged and is now stronger: not merely "the stamp did not land" but "the stamp did not
     * land AND the turn was told".
     *
     * No real turn reaches this. The loader above returns null for the same row on the same actor,
     * so `resolvePart`'s `"fail"` mode refuses that turn several steps earlier; a colleague's staged
     * draft never gets as far as being recorded as sent. It is asserted here because the function is
     * callable on its own and its answer to an id it cannot account for should not depend on who
     * remembered to call the loader first.
     */
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let refused: unknown;
    try {
      refused = await markAttachmentsSent(
        db,
        { actorId: otherMemberId, threadId },
        [id],
      ).then(
        () => null,
        (reason: unknown) => reason,
      );
    } finally {
      quiet.mockRestore();
    }
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain(id);

    expect(await attachedAtOf(db, id)).toBeNull();

    // And the uploader's own send is what the column was always supposed to be about.
    await markAttachmentsSent(db, { actorId: memberId, threadId }, [id]);
    expect(await attachedAtOf(db, id)).toBeInstanceOf(Date);

    // Once it has been sent it is the conversation's, and the same colleague reads it like any
    // other member — which is the half of the rule that must NOT change.
    expect(
      (
        await loadAttachmentForTurn(
          db,
          { actorId: otherMemberId, threadId },
          id,
        )
      )?.name,
    ).toBe("draft.txt");
  });

  /*
   * The turn path carries the channel scope too. This is the one of the three that hands bytes to a
   * model rather than to a browser: without it, a member of a deleted channel could name an id out
   * of their own local transcript and have the file read back to them for ever.
   */
  test("an attachment in a soft-deleted channel is not loaded for a turn", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "notes.txt",
      text: "hello",
    });
    // Loadable first, so the null below is the deletion and not a broken fixture.
    expect(
      await loadAttachmentForTurn(db, { actorId: memberId, threadId }, id),
    ).not.toBeNull();

    await db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));

    expect(
      await loadAttachmentForTurn(db, { actorId: memberId, threadId }, id),
    ).toBeNull();
  });

  test("a missing attachment returns null", async () => {
    const { database: db, memberId, threadId } = await harness();

    const loaded = await loadAttachmentForTurn(
      db,
      { actorId: memberId, threadId },
      randomUUID(),
    );

    expect(loaded).toBeNull();
  });

  /*
   * The id a turn is handed is not a path param that routing shaped. `attachmentIdFor`
   * (attachment-parts.ts) slices whatever follows `/api/attachments/` out of a browser-supplied
   * message part, so a query string, a second path segment and the empty string all arrive here as
   * "ids". Compared against a `uuid` column, each of those raises Postgres `22P02` and THROWS, and a
   * throw is not the same answer as a miss: `resolvePart` degrades a NULL into the "no longer
   * available" note for an older message, and only fails the turn on the message being asked about.
   * A throw skips that degradation entirely, and because history is replayed on every turn, one
   * malformed part would fail this channel's every future turn for ever.
   */
  test("a malformed id misses instead of throwing, so history still degrades", async () => {
    const { database: db, memberId, threadId } = await harness();

    for (const malformed of [
      `${randomUUID()}?download=1`,
      `${randomUUID()}/bytes`,
      "not-a-uuid",
      "",
    ]) {
      expect(
        await loadAttachmentForTurn(
          db,
          { actorId: memberId, threadId },
          malformed,
        ),
      ).toBeNull();
    }

    // The consequence of that difference, at the layer that feels it: the same id on an older
    // message becomes a note the model can read, not a turn that can never run again.
    const noted = await resolveAttachmentParts(
      [
        {
          type: "image",
          source: { type: "url", value: attachmentUrl("not-a-uuid") },
          metadata: { filename: "chart.png" },
        },
      ],
      (partId) =>
        loadAttachmentForTurn(db, { actorId: memberId, threadId }, partId),
      "note",
    );
    expect(noted).toEqual([
      { type: "text", text: '[attachment "chart.png" is no longer available]' },
    ]);
  });
});

describe("markAttachmentsSent", () => {
  /*
   * THE HARM THAT WAS REPRODUCED, and the reason the write carries the scope as well as the read.
   *
   * One person, two channels of their own, no colleague involved. They name a file from A on a
   * message they send in B, and this used to stamp the row in A. Nothing in A ever referred to it,
   * and the stamp is not cosmetic — three readers treat a non-null `attachedAt` as "this file rode
   * in a message somebody sent": the withdrawal route refuses it with a 409, the culler stops
   * reclaiming it, and the upload cap stops counting it. So the file became one the person could
   * neither send from A, nor withdraw from A, nor wait out. It is the same freeze the `uploadedBy`
   * term exists to prevent, reached without anybody else's help.
   */
  test("a send in another channel does not stamp a row that lives in this one", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const other = await secondChannelFor(db, memberId);

    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "budget.txt",
      text: "staged in the first channel",
    });

    /*
     * The send happens in the OTHER conversation, naming this channel's file — and it is now
     * REFUSED rather than quietly declined. The id names a row this conversation cannot account
     * for, which is the whole of what the verification asks, and the answer to "I cannot record
     * this send" is to say so before the turn is spent rather than to carry on as though it had
     * been recorded.
     *
     * No real turn reaches this either: `loadAttachmentForTurn` carries the same channel term, so
     * the bytes are already refused and `resolvePart`'s `"fail"` mode has failed the turn well
     * before a stamp is attempted. What this pins is that the row in A is untouched, which was
     * always the point and which the rollback below now also guarantees.
     */
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let elsewhere: unknown;
    try {
      elsewhere = await markAttachmentsSent(
        db,
        { actorId: memberId, threadId: other.threadId },
        [id],
      ).then(
        () => null,
        (reason: unknown) => reason,
      );
    } finally {
      quiet.mockRestore();
    }
    expect(elsewhere).toBeInstanceOf(Error);
    expect(await attachedAtOf(db, id)).toBeNull();

    // And the row is untouched rather than merely unstamped: still staged, still withdrawable, and
    // still stampable by the send it actually belongs to.
    await markAttachmentsSent(db, { actorId: memberId, threadId }, [id]);
    expect(await attachedAtOf(db, id)).toBeInstanceOf(Date);
  });

  /*
   * The same degrade the reader has, and deliberately not a stricter rule.
   *
   * An inner join here looked free — a hop's asked message is `handoff-delivery.ts`'s synthetic
   * instruction, which names no attachment, so nothing would ever reach the statement. It was
   * rejected because of the direct `/bot` chat, where an unmapped thread CAN carry a real send: a
   * strict write would silently never stamp those rows, and the culler would delete a file out from
   * under a conversation that still shows it — failing in the exact direction this column exists to
   * prevent. One rule for both is also one rule to keep true.
   */
  test("a send on a thread that maps to no channel still records itself", async () => {
    const { database: db, channelId, memberId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "budget.txt",
      text: "sent from a conversation this deployment keeps no channel for",
    });

    const scratchThread = `${testPrefix}-scratch-${randomUUID()}`;
    await markAttachmentsSent(
      db,
      { actorId: memberId, threadId: scratchThread },
      [id],
    );

    expect(await attachedAtOf(db, id)).toBeInstanceOf(Date);
  });

  test("the uploader's send stamps their staged row, and a replay of it changes nothing", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "hello",
    });

    await markAttachmentsSent(db, { actorId: memberId, threadId }, [id]);
    const first = await attachedAtOf(db, id);
    expect(first).toBeInstanceOf(Date);

    // A stopped run retried, or the same message replayed as history on a later turn. Neither is a
    // new send, and neither may move a timestamp that already means something.
    await markAttachmentsSent(db, { actorId: memberId, threadId }, [id]);
    // Both sides read through `?.`, so a vanished row would have compared `undefined` to
    // `undefined` and called the timestamp unmoved. Take the number out of `first` once, above,
    // and demand a number on both sides.
    const second = await attachedAtOf(db, id);
    expect(second).toBeInstanceOf(Date);
    expect((second as Date).getTime()).toBe((first as Date).getTime());
  });

  /*
   * These ids are not path params that routing shaped: `attachmentIdFor` slices whatever follows
   * `/api/attachments/` out of a browser-supplied message part, so a query string, a second path
   * segment and the empty string all arrive as "ids". Compared against a `uuid` column each raises
   * Postgres `22P02` and throws — and a throw out of this function now REFUSES THE TURN, so the
   * guard matters more than it did when everything here was swallowed: a part that is not an
   * attachment reference at all would otherwise fail the send of the real file beside it.
   */
  test("ids that could never name a row are dropped rather than asked about", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "sent.txt",
      text: "hello",
    });

    await markAttachmentsSent(db, { actorId: memberId, threadId }, [
      `${randomUUID()}?download=1`,
      "not-a-uuid",
      "",
      id,
    ]);

    // The one real id in that list was still recorded, so the guard drops ids rather than sends.
    expect(await attachedAtOf(db, id)).toBeInstanceOf(Date);
  });

  /*
   * A WRITE THAT NEVER LANDED USED TO REPORT A SEND, and the turn carried on to the model.
   *
   * The statement was `.catch`ed and logged, so `markAttachmentsSent` resolved whatever the database
   * did — and `inlineAttachments` had already read the bytes, so the Bot answered about a file whose
   * `attachedAt` stayed null. The culler reclaims exactly those rows, so a day later the message was
   * still displaying an attachment that no longer existed. Nobody was told at either end.
   *
   * Through the real driver rather than a stub that returns a rejected promise: the failures this
   * has to answer for are a lost connection, an exhausted pool and a `statement_timeout`, all of
   * which arrive as "the driver could not answer this query", which is what a closed port produces.
   *
   * The unstamped row is asserted on the REAL database, because "it raised" and "it raised and left
   * the row alone" are different claims and only the second one makes the retry safe.
   */
  test("a write the database refuses is raised rather than reported as a send", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const id = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "receipt.txt",
      text: "sent into a database that cannot be reached",
    });

    // Collected into a local rather than read off the spy, because `mockRestore` clears the recorded
    // calls and the assertion below would then be made against an empty log whatever happened.
    const logged: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      },
    );
    let raised: unknown;
    try {
      raised = await markAttachmentsSent(
        unreachableDatabase,
        { actorId: memberId, threadId },
        [id],
      ).then(
        () => null,
        (reason: unknown) => reason,
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(raised).toBeInstanceOf(Error);
    // A sentence somebody can act on, naming the file and saying the turn did not run — this leaves
    // through the run as an AG-UI error and is shown to the person who was waiting.
    expect((raised as Error).message).toContain(id);
    expect((raised as Error).message).toContain("was not run");
    expect((raised as Error).message).toContain("attach the file again");
    // And named for whoever has to act on it from the other side. Every consequence of a missing
    // stamp is about a specific person and a specific row.
    expect(logged.join(" ")).toContain(memberId);
    expect(logged.join(" ")).toContain(id);
    // Still staged: still withdrawable, still countable against the cap, still stampable by a retry.
    expect(await attachedAtOf(db, id)).toBeNull();
  });

  /*
   * THE ROW DISAPPEARING BETWEEN THE LOAD AND THE STAMP, which is the failure a row count cannot see.
   *
   * Postgres reports an UPDATE that matched nothing as a successful command, so a withdrawal (or a
   * cull) committing in that window left `markAttachmentsSent` resolving happily over a file that
   * was no longer there. The window is not theoretical and it is not short: `inlineAttachments`
   * reads the asked message's bytes FIRST and then walks the whole history behind it, so it is one
   * database round trip per older message wide, and it is the sender's own composer — which goes on
   * offering the file for withdrawal until the send is recorded — on the other side of it.
   *
   * Driven as a real race rather than by deleting the row beforehand, because the claim is about
   * what Postgres does when the two statements actually contend: the stamp is blocked on the row,
   * `pg_blocking_pids` says so, and only then does the withdrawal commit. The delete carries the
   * same WHERE `DELETE /api/attachments/:id` carries, so what is racing the stamp is the withdrawal
   * route's own statement and not a convenient approximation of it.
   *
   * The other direction is pinned by "a send landing mid-request cannot have its file deleted out
   * from under it" above: stamp first, and the withdrawal's `attached_at is null` no longer holds so
   * it takes nothing and answers 409. Between the two, neither can win twice.
   */
  test(
    "a withdrawal landing between the load and the stamp refuses the send",
    async () => {
      const { database: db, channelId, memberId, threadId } = await harness();
      const id = await uploadText(db, {
        channelId,
        uploadedBy: memberId,
        name: "draft.txt",
        text: "withdrawn while the turn was being prepared",
      });

      // The bytes really were readable when the turn started, which is what makes this a race rather
      // than a send naming a file that was never there.
      expect(
        await loadAttachmentForTurn(db, { actorId: memberId, threadId }, id),
      ).not.toBeNull();

      const consoleError = spyOn(console, "error").mockImplementation(() => {});
      let refusal: unknown;
      try {
        refusal = await stampWhileTheRowIsHeld(
          db,
          { actorId: memberId, threadId },
          id,
          async (held) => {
            await held
              .delete(attachments)
              .where(
                and(
                  eq(attachments.id, id),
                  eq(attachments.uploadedBy, memberId),
                  isNull(attachments.attachedAt),
                ),
              );
          },
        );
      } finally {
        consoleError.mockRestore();
      }

      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(id);
      // `toBeUndefined` rather than `not.toBeNull`, which the three-valued helper would satisfy with
      // the very absence being asserted. The withdrawal won; the point is that the send says so.
      expect(await attachedAtOf(db, id)).toBeUndefined();
    },
    BLOCKED_SESSION_TIMEOUT_MS,
  );

  /*
   * AND THE STAMP ANOTHER RUN ALREADY LANDED IS A RECORDED SEND, NOT A LOST RACE.
   *
   * This is the over-correction the check above has to avoid, and it is the reason the verification
   * is a SECOND STATEMENT rather than a CTE reading beside the UPDATE. A data-modifying CTE and the
   * query next to it share one snapshot, taken when the statement began, so a row a neighbour
   * stamped a moment ago would be invisible to the read while the UPDATE's own re-check correctly
   * declined to stamp it twice — and two runs of the same message would refuse each other. Under
   * READ COMMITTED a separate statement takes a fresh snapshot and sees the commit.
   *
   * Reachable without anybody doing anything strange: a stopped run retried, or a second tab. Same
   * race as the test above, with the holding transaction stamping instead of withdrawing.
   */
  test(
    "a stamp another run landed first is a recorded send rather than a refusal",
    async () => {
      const { database: db, channelId, memberId, threadId } = await harness();
      const id = await uploadText(db, {
        channelId,
        uploadedBy: memberId,
        name: "retried.txt",
        text: "sent twice at once",
      });

      const outcome = await stampWhileTheRowIsHeld(
        db,
        { actorId: memberId, threadId },
        id,
        async (held) => {
          await held
            .update(attachments)
            .set({ attachedAt: new Date() })
            .where(and(eq(attachments.id, id), isNull(attachments.attachedAt)));
        },
      );

      expect(outcome).toBeNull();
      expect(await attachedAtOf(db, id)).toBeInstanceOf(Date);
    },
    BLOCKED_SESSION_TIMEOUT_MS,
  );

  /*
   * THE OTHER WAY A ROW COUNT LIES: A SENT FILE THIS PERSON DID NOT UPLOAD.
   *
   * Members are meant to see each other's sent files, so a message may perfectly well name one — and
   * `uploadedBy` in the WHERE is what stops a sender freezing a colleague's row, so the UPDATE
   * matching it is exactly what must NOT happen. One id in, zero rows out, and nothing wrong. A
   * check that compared rows updated against ids requested would refuse this turn, which is why the
   * verification asks whether each id IS recorded rather than whether this statement recorded it.
   *
   * Both ids at once, because the mixed message is the shape that catches a check applied per-list
   * instead of per-id.
   */
  test("a colleague's already-sent file on this message does not refuse the send", async () => {
    const { database: db, channelId, memberId, threadId } = await harness();
    const colleagueId = `${testPrefix}-colleague-${randomUUID()}`;
    await db.insert(users).values({
      id: colleagueId,
      email: `${colleagueId}@example.test`,
    });
    createdUserIds.push(colleagueId);
    await db
      .insert(channelMemberships)
      .values({ channelId, userId: colleagueId });

    const theirs = await uploadText(db, {
      channelId,
      uploadedBy: colleagueId,
      name: "shared.txt",
      text: "sent by somebody else, earlier",
    });
    await markAttachmentsSent(db, { actorId: colleagueId, threadId }, [theirs]);
    const theirStamp = await attachedAtOf(db, theirs);
    expect(theirStamp).toBeInstanceOf(Date);

    const mine = await uploadText(db, {
      channelId,
      uploadedBy: memberId,
      name: "mine.txt",
      text: "staged by the person sending this message",
    });

    await expect(
      markAttachmentsSent(db, { actorId: memberId, threadId }, [theirs, mine]),
    ).resolves.toBeUndefined();

    expect(await attachedAtOf(db, mine)).toBeInstanceOf(Date);
    // Untouched rather than merely unrefused: the colleague's stamp still says when THEY sent it.
    expect((await attachedAtOf(db, theirs)) as Date).toEqual(
      theirStamp as Date,
    );
  });

  /*
   * "NOT A QUERY" IS THE CLAIM, SO A QUERY IS WHAT THIS HAS TO CATCH.
   *
   * It used to assert `resolves.toBeUndefined()` against a real database, which
   * `markAttachmentsSent` satisfied whatever it did: it returns `Promise<void>`, and back when it
   * caught its own database failures and only logged them, deleting the guard this claims to pin
   * left it green — the ids would have gone to Postgres, raised `22P02` on the `uuid` column, been
   * swallowed, and still resolved `undefined`.
   *
   * A rejection would be visible now that the failure is raised, so that hole has closed on its own.
   * The untouchable database stays, because it pins the STRONGER claim the sentence above actually
   * makes: not that nothing broke, but that nothing was ASKED.
   *
   * A database that refuses to be touched is what makes the claim testable: any property this
   * function reads off it throws, so the assertion "this resolved quietly" can only be true if
   * nothing was asked.
   */
  test("nothing to record is not a query", async () => {
    const untouchable = new Proxy({} as Database, {
      get(_target, property) {
        throw new Error(
          `markAttachmentsSent reached for database.${String(property)} with nothing to record.`,
        );
      },
    });

    // Every shape `attachmentIdFor` can produce that no `uuid` column could hold.
    await expect(
      markAttachmentsSent(
        untouchable,
        { actorId: "nobody", threadId: "nobody" },
        ["not-a-uuid", "", `${randomUUID()}?download=1`],
      ),
    ).resolves.toBeUndefined();

    // And an empty list, which is the case the early return is named for.
    await expect(
      markAttachmentsSent(
        untouchable,
        { actorId: "nobody", threadId: "nobody" },
        [],
      ),
    ).resolves.toBeUndefined();
  });

  /*
   * THE HELPER'S OWN DIAGNOSTIC, WHICH USED TO BE UNREACHABLE.
   *
   * `waitForBlockedSession` gave itself 5s and Bun gives a test 5s by default, with no override
   * anywhere, so the runner always won: the message naming the session that never blocked could not
   * be printed, and both races failed as a bare "timed out after 5000ms" instead. The constants are
   * compared here because that relationship is the fault, and the message is provoked with a short
   * deadline because waiting the real one out would cost the suite seven seconds to observe a
   * string.
   */
  test("the wait for a blocked session says which session it gave up on", async () => {
    expect(BLOCKED_SESSION_DEADLINE_MS).toBeLessThan(
      BLOCKED_SESSION_TIMEOUT_MS,
    );

    const applicationName = `never_blocks_${randomUUID()}`;
    await expect(
      waitForBlockedSession(applicationName, () => false, 50),
    ).rejects.toThrow(applicationName);
  });
});

/**
 * `attachments.name` is a Postgres `text` column and Postgres refuses U+0000 in one, so a NUL
 * cannot reach the fetch route through the database the way the other control characters can. The
 * builder is called directly here because that is the only way left to prove it never hands the
 * header serializer a byte it would throw on — and that throw would come from inside `c.body`,
 * after the response had already begun, with no `app.onError` behind the router to turn it into
 * anything but a 500 on every fetch of the attachment.
 */
describe("contentDispositionFilename", () => {
  test("a NUL in the filename never reaches the header value", () => {
    const value = `attachment; ${contentDispositionFilename("a\u0000b.txt")}`;

    expect(value).toContain('filename="a_b.txt"');
    expect(value).toContain("filename*=UTF-8''a_b.txt");
    expect(controlCharactersIn(value)).toEqual([]);
    expect(
      () => new Response(null, { headers: { "Content-Disposition": value } }),
    ).not.toThrow();
  });

  test("a C0 control character in the filename never reaches the header value", () => {
    const value = `attachment; ${contentDispositionFilename("a\u0001b\u001Fc.txt")}`;

    expect(value).toContain('filename="a_b_c.txt"');
    expect(value).toContain("filename*=UTF-8''a_b_c.txt");
    expect(controlCharactersIn(value)).toEqual([]);
  });

  test("CR and LF still cannot open a second header line", () => {
    const value = contentDispositionFilename("a\r\nX-Injected: 1.txt");

    expect(value).toContain('filename="a__X-Injected: 1.txt"');
    expect(controlCharactersIn(value)).toEqual([]);
  });

  test("an ordinary name is untouched and a quote or backslash is still escaped", () => {
    expect(contentDispositionFilename("notes.txt")).toBe(
      `filename="notes.txt"; filename*=UTF-8''notes.txt`,
    );
    expect(contentDispositionFilename('a"b\\c.txt')).toContain(
      'filename="a\\"b\\\\c.txt"',
    );
  });
});
