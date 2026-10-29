import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { type AuditEventInput, createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, users } from "../src/db/schema/core";
import {
  recorderConnectCodes,
  recorderConnections,
} from "../src/db/schema/recorder";
import {
  createRecorderConnectionStore,
  type RecorderConnectionLifetime,
} from "../src/recorder/connections";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-connections-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createRecorderConnectionStore(database);
const CHROME = "c".repeat(32); // an install id (Decision 18): 32 lowercase hex digits
const EDGE = "e".repeat(32);

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

/** Mints a code, failing the test when the store refuses one. A sealed session's cookie expires a week from now unless
 * the test says when. */
async function mint(
  on: ReturnType<typeof createRecorderConnectionStore>,
  userId: string,
  via: "web" | "desktop",
  organizationSession: string | null = null,
  cookieExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000),
) {
  const minted = await on.mintCode(
    userId,
    via,
    organizationSession
      ? { sealed: organizationSession, expiresAt: cookieExpiresAt }
      : null,
  );
  if (!minted) throw new Error("the store refused a connect code");
  return minted;
}

async function connect(installId: string, label = "Chrome on macOS") {
  const { code } = await mint(store, owner, "web");
  const made = await store.exchange({
    code,
    label,
    extensionId: RECORDER_EXTENSION_ID,
    installId,
  });
  if (!made) throw new Error("the exchange was refused");
  return made;
}

test("a connect code works once and yields a token that resolves to its person", async () => {
  const { code } = await mint(store, owner, "web");
  const first = await store.exchange({
    code,
    label: "Chrome on macOS",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  expect(first?.userId).toBe(owner);
  expect(first?.token).toMatch(/^obr_[A-Za-z0-9_-]{43}$/);
  expect(code).toMatch(/^obc_[A-Za-z0-9_-]{43}$/);
  expect(
    await store.exchange({
      code,
      label: "again",
      extensionId: RECORDER_EXTENSION_ID,
      installId: CHROME,
    }),
  ).toBeNull();
  expect(await store.resolve(first!.token)).toEqual({
    connectionId: first!.connection.id,
    userId: owner,
    organizationSession: null,
  });
});

test("an expired code is refused", async () => {
  const late = createRecorderConnectionStore(database, {
    now: () => new Date(Date.now() + 6 * 60_000),
  });
  const { code } = await mint(store, owner, "web");
  expect(
    await late.exchange({
      code,
      label: "x",
      extensionId: RECORDER_EXTENSION_ID,
      installId: CHROME,
    }),
  ).toBeNull();
});

test("an unknown code is refused", async () => {
  expect(
    await store.exchange({
      code: `obc_${"A".repeat(43)}`,
      label: "x",
      extensionId: RECORDER_EXTENSION_ID,
      installId: CHROME,
    }),
  ).toBeNull();
});

test("only digests are stored", async () => {
  const { code } = await mint(store, owner, "desktop");
  const made = await store.exchange({
    code,
    label: "Edge on Windows",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  const rows = await database
    .select()
    .from(recorderConnections)
    .where(eq(recorderConnections.userId, owner));
  expect(JSON.stringify(rows)).not.toContain(made!.token);
  expect(
    JSON.stringify(await database.select().from(recorderConnectCodes)),
  ).not.toContain(code);
});

test("an organization session travels from the code to the connection", async () => {
  const { code } = await mint(store, owner, "web", "sealed-value");
  const made = await store.exchange({
    code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  expect((await store.resolve(made!.token))?.organizationSession).toBe(
    "sealed-value",
  );
});

test("a revoked connection stops resolving and leaves the list", async () => {
  const made = await connect(EDGE);
  expect(await store.revoke(owner, made.connection.id, "revoked")).toBe(true);
  expect(await store.resolve(made.token)).toBeNull();
  expect((await store.list(owner)).map((c) => c.id)).not.toContain(
    made.connection.id,
  );
});

test("last use is recorded at most once a minute", async () => {
  let now = new Date();
  const clocked = createRecorderConnectionStore(database, { now: () => now });
  const { code } = await mint(clocked, owner, "web");
  const made = await clocked.exchange({
    code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  const lastUsed = async () =>
    (
      await database
        .select({ at: recorderConnections.lastUsedAt })
        .from(recorderConnections)
        .where(eq(recorderConnections.id, made!.connection.id))
    )[0]?.at;
  expect(await lastUsed()).toBeNull();
  const first = now;
  await clocked.resolve(made!.token);
  expect((await lastUsed())?.getTime()).toBe(first.getTime());
  now = new Date(first.getTime() + 10_000);
  await clocked.resolve(made!.token);
  expect((await lastUsed())?.getTime()).toBe(first.getTime());
  now = new Date(first.getTime() + 61_000);
  await clocked.resolve(made!.token);
  expect((await lastUsed())?.getTime()).toBe(now.getTime());
});

test("revoking someone else's connection does nothing", async () => {
  const made = await connect(CHROME);
  expect(await store.revoke(other, made.connection.id, "revoked")).toBe(false);
  expect(await store.resolve(made.token)).not.toBeNull();
});

test("the same copy connecting again replaces its older connection; another copy does not", async () => {
  const first = await connect(CHROME, "Chrome");
  const edge = await connect(EDGE, "Edge");
  const again = await connect(CHROME, "Chrome");
  expect(again.replaced).toBe(first.connection.id);
  expect(edge.replaced).toBeNull();
  expect(await store.resolve(first.token)).toBeNull();
  expect(await store.resolve(edge.token)).not.toBeNull();
  expect((await store.list(owner)).map((c) => c.installId).sort()).toEqual([
    CHROME,
    EDGE,
  ]);
});

const sessionOf = async (connectionId: string) =>
  (
    await database
      .select({ sealed: recorderConnections.organizationSession })
      .from(recorderConnections)
      .where(eq(recorderConnections.id, connectionId))
  )[0]?.sealed;

test("a used code is deleted with the organization session it held", async () => {
  const { code } = await mint(store, owner, "web", "sealed-once");
  const made = await store.exchange({
    code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  expect(made).not.toBeNull();
  const kept = await database
    .select({ sealed: recorderConnectCodes.organizationSession })
    .from(recorderConnectCodes)
    .where(eq(recorderConnectCodes.userId, owner));
  expect(kept.map((row) => row.sealed)).not.toContain("sealed-once");
});

test("revoking a connection, or replacing it, drops its organization session", async () => {
  const revokedCode = await mint(store, owner, "web", "sealed-revoked");
  const revoked = await store.exchange({
    code: revokedCode.code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  expect(await sessionOf(revoked!.connection.id)).toBe("sealed-revoked");
  expect(await store.revoke(owner, revoked!.connection.id, "revoked")).toBe(
    true,
  );
  expect(await sessionOf(revoked!.connection.id)).toBeNull();

  const firstCode = await mint(store, owner, "web", "sealed-first");
  const first = await store.exchange({
    code: firstCode.code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  const againCode = await mint(store, owner, "web", "sealed-again");
  const again = await store.exchange({
    code: againCode.code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  expect(again!.replaced).toBe(first!.connection.id);
  expect(await sessionOf(first!.connection.id)).toBeNull();
  expect(await sessionOf(again!.connection.id)).toBe("sealed-again");
});

test("minting a code deletes every expired one, with its organization session", async () => {
  await mint(store, other, "web", "sealed-expired");
  const late = createRecorderConnectionStore(database, {
    now: () => new Date(Date.now() + 6 * 60_000),
  });
  await mint(late, owner, "web");
  const expired = await database
    .select({ sealed: recorderConnectCodes.organizationSession })
    .from(recorderConnectCodes)
    .where(
      and(
        eq(recorderConnectCodes.userId, other),
        eq(recorderConnectCodes.organizationSession, "sealed-expired"),
      ),
    );
  expect(expired).toEqual([]);
});

test("a person holding ten unexpired codes is refused another until one is used or expires", async () => {
  const person = `${prefix}-busy`;
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
  try {
    const codes = [];
    for (let index = 0; index < 10; index += 1) {
      codes.push(await mint(store, person, "web"));
    }
    expect(await store.mintCode(person, "web")).toBeNull();
    // Another person is not held back by this one.
    expect(await store.mintCode(other, "web")).not.toBeNull();
    await store.exchange({
      code: codes[0]!.code,
      label: "x",
      extensionId: RECORDER_EXTENSION_ID,
      installId: "f".repeat(32),
    });
    expect(await store.mintCode(person, "web")).not.toBeNull();
    const later = createRecorderConnectionStore(database, {
      now: () => new Date(Date.now() + 6 * 60_000),
    });
    expect(await later.mintCode(person, "web")).not.toBeNull();
  } finally {
    await database.delete(users).where(eq(users.id, person));
  }
});

/** A person of their own, so one test's codes and connections never meet another's. */
async function newPerson(name: string) {
  const id = `${prefix}-${name}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  return id;
}

/** This person's live connections for one copy, straight from the table. */
const liveFor = (userId: string, installId: string) =>
  database
    .select({ id: recorderConnections.id })
    .from(recorderConnections)
    .where(
      and(
        eq(recorderConnections.userId, userId),
        eq(recorderConnections.installId, installId),
        isNull(recorderConnections.revokedAt),
      ),
    );

describe("at the same moment", () => {
  test("two exchanges for the same person and copy at once both connect, and the later replaces the earlier", async () => {
    const person = await newPerson("twice");
    const rows: AuditEventInput[] = [];
    const audited = createRecorderConnectionStore(database, {
      auditFor: () => ({
        insert: async (event) => {
          rows.push(event);
        },
      }),
    });
    try {
      // Several rounds, each a new copy: without the turn, one exchange of a pair broke the one-live-connection index.
      for (let round = 0; round < 8; round += 1) {
        const installId = round.toString(16).repeat(32);
        const codes = [
          await mint(audited, person, "web"),
          await mint(audited, person, "web"),
        ];
        const made = await Promise.all(
          codes.map(({ code }) =>
            audited.exchange({
              code,
              label: "Chrome",
              extensionId: RECORDER_EXTENSION_ID,
              installId,
            }),
          ),
        );
        expect(made.every((one) => one !== null)).toBe(true);
        const [first, second] = made as NonNullable<(typeof made)[number]>[];
        // Exactly one replaced the other, and only the one that did still stands.
        const later = first!.replaced ? first! : second!;
        const earlier = later === first ? second! : first!;
        expect(later.replaced).toBe(earlier.connection.id);
        expect(earlier.replaced).toBeNull();
        expect((await liveFor(person, installId)).map((row) => row.id)).toEqual(
          [later.connection.id],
        );
        expect(await audited.resolve(earlier.token)).toBeNull();
        expect((await audited.resolve(later.token))?.userId).toBe(person);
        expect(
          rows.filter(
            (row) =>
              row.eventType === "recorder.revoked" &&
              row.targetId === earlier.connection.id,
          ),
        ).toEqual([
          expect.objectContaining({
            actorUserId: person,
            payload: {
              connectionId: earlier.connection.id,
              via: "web",
              reason: "replaced",
            },
          }),
        ]);
      }
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });

  test("many codes asked for at once never leave a person holding more than ten", async () => {
    const person = await newPerson("burst");
    // A pool of its own, wide enough that the asks really do run side by side.
    const wide = createDatabase(testDatabaseUrl(), { max: 8 });
    const burst = createRecorderConnectionStore(wide);
    try {
      const minted = await Promise.all(
        Array.from({ length: 24 }, () => burst.mintCode(person, "web")),
      );
      expect(minted.filter((one) => one !== null)).toHaveLength(10);
      const held = await database
        .select({ codeHash: recorderConnectCodes.codeHash })
        .from(recorderConnectCodes)
        .where(
          and(
            eq(recorderConnectCodes.userId, person),
            gt(recorderConnectCodes.expiresAt, new Date()),
          ),
        );
      expect(held).toHaveLength(10);
    } finally {
      await wide.$client.close();
      await database.delete(users).where(eq(users.id, person));
    }
  });
});

describe("a connection's row is written with it", () => {
  const failing = () => ({
    insert: async () => {
      throw new Error("the audit trail is unavailable");
    },
  });

  test("a connection whose row cannot be written is not made, and its code can be used again", async () => {
    const person = await newPerson("unaudited");
    try {
      const { code } = await mint(store, person, "web");
      const broken = createRecorderConnectionStore(database, {
        auditFor: failing,
      });
      await expect(
        broken.exchange({
          code,
          label: "Chrome",
          extensionId: RECORDER_EXTENSION_ID,
          installId: CHROME,
        }),
      ).rejects.toThrow("the audit trail is unavailable");
      expect(await liveFor(person, CHROME)).toEqual([]);

      // Nothing changed, the code included: the next try, with the trail back, connects.
      const real = createRecorderConnectionStore(database, {
        auditFor: (executor) => createAuditStore(executor),
      });
      const made = await real.exchange({
        code,
        label: "Chrome",
        extensionId: RECORDER_EXTENSION_ID,
        installId: CHROME,
      });
      expect(made?.userId).toBe(person);
      const written = await database
        .select({
          eventType: auditEvents.eventType,
          actorUserId: auditEvents.actorUserId,
        })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, made!.connection.id));
      expect(written).toEqual([
        { eventType: "recorder.connected", actorUserId: person },
      ]);
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });

  test("a revoke whose row cannot be written does not happen", async () => {
    const person = await newPerson("unrevoked");
    try {
      const { code } = await mint(store, person, "web");
      const made = await store.exchange({
        code,
        label: "Chrome",
        extensionId: RECORDER_EXTENSION_ID,
        installId: CHROME,
      });
      const broken = createRecorderConnectionStore(database, {
        auditFor: failing,
      });
      await expect(
        broken.revoke(person, made!.connection.id, "revoked"),
      ).rejects.toThrow("the audit trail is unavailable");
      expect(await store.resolve(made!.token)).not.toBeNull();
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });
});

describe("how long a connection lasts", () => {
  const WEEK = 7 * 24 * 60 * 60_000;
  const MINUTE = 60_000;

  /** A store on a clock the test moves, with the given lifetime, keeping the rows it writes. */
  function clocked(lifetime: RecorderConnectionLifetime) {
    const clock = { now: new Date() };
    const rows: AuditEventInput[] = [];
    const on = createRecorderConnectionStore(database, {
      now: () => clock.now,
      lifetime,
      auditFor: () => ({
        insert: async (event) => {
          rows.push(event);
        },
      }),
    });
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    return { on, rows, later };
  }

  async function connectOn(
    on: ReturnType<typeof createRecorderConnectionStore>,
    person: string,
    installId = CHROME,
    organizationSession: string | null = null,
    cookieExpiresAt?: Date,
  ) {
    const { code } = await mint(
      on,
      person,
      "web",
      organizationSession,
      cookieExpiresAt,
    );
    const made = await on.exchange({
      code,
      label: "Chrome",
      extensionId: RECORDER_EXTENSION_ID,
      installId,
    });
    if (!made) throw new Error("the exchange was refused");
    return made;
  }

  test("as a Better Auth session: it ends once it has gone unused for the session's lifetime, and use keeps it going", async () => {
    const person = await newPerson("idle");
    const { on, later } = clocked({ kind: "idle", ms: WEEK });
    try {
      const made = await connectOn(on, person);
      later(WEEK - MINUTE);
      expect((await on.resolve(made.token))?.userId).toBe(person);
      // Used a minute before the week was out: another week from that use.
      later(WEEK - MINUTE);
      expect((await on.resolve(made.token))?.userId).toBe(person);
      expect((await on.list(person)).map((row) => row.id)).toContain(
        made.connection.id,
      );
      later(WEEK + MINUTE);
      expect(await on.resolve(made.token)).toBeNull();
      expect((await on.list(person)).map((row) => row.id)).not.toContain(
        made.connection.id,
      );
      expect((await on.reporting(person)).map((row) => row.id)).not.toContain(
        made.connection.id,
      );
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });

  test("as an organization session cookie: it ends when the cookie it copies expires, not a week from connecting", async () => {
    const person = await newPerson("cookie");
    const { on, rows, later } = clocked({ kind: "organization", ms: WEEK });
    try {
      // The cookie was set five days ago, so it has two days left when the browser connects.
      const cookieExpiresAt = new Date(Date.now() + 2 * 24 * 60 * MINUTE);
      const made = await connectOn(
        on,
        person,
        CHROME,
        "sealed-cookie",
        cookieExpiresAt,
      );
      later(2 * 24 * 60 * MINUTE - MINUTE);
      expect((await on.resolve(made.token))?.organizationSession).toBe(
        "sealed-cookie",
      );
      later(2 * MINUTE);
      expect(await on.resolve(made.token)).toBeNull();
      // And the sweep takes the copy away then, five days before a week from connecting would have.
      expect(await on.expire()).toBeGreaterThanOrEqual(1);
      expect(await sessionOf(made.connection.id)).toBeNull();
      expect(
        rows.find(
          (row) =>
            row.eventType === "recorder.revoked" &&
            row.targetId === made.connection.id,
        )?.payload.reason,
      ).toBe("expired");
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });

  test("an organization connection made before the cookie's expiry was kept lasts the cookie's Max-Age from connecting", async () => {
    const person = await newPerson("unknown-expiry");
    const { on, later } = clocked({ kind: "organization", ms: WEEK });
    try {
      const made = await connectOn(on, person, CHROME, "sealed-older");
      await database
        .update(recorderConnections)
        .set({ organizationSessionExpiresAt: null })
        .where(eq(recorderConnections.id, made.connection.id));
      later(WEEK - MINUTE);
      expect((await on.resolve(made.token))?.userId).toBe(person);
      later(2 * MINUTE);
      expect(await on.resolve(made.token)).toBeNull();
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });

  test("the expiry sweep ends what ran out, with the sealed session it held, and says so once", async () => {
    const person = await newPerson("swept");
    const { on, rows, later } = clocked({ kind: "idle", ms: WEEK });
    try {
      const stale = await connectOn(on, person, CHROME, "sealed-stale");
      later(WEEK - MINUTE);
      const fresh = await connectOn(on, person, EDGE, "sealed-fresh");
      later(2 * MINUTE);
      expect(await on.expire()).toBeGreaterThanOrEqual(1);
      expect(await sessionOf(stale.connection.id)).toBeNull();
      expect(await sessionOf(fresh.connection.id)).toBe("sealed-fresh");
      expect(await liveFor(person, CHROME)).toEqual([]);
      expect((await liveFor(person, EDGE)).map((row) => row.id)).toEqual([
        fresh.connection.id,
      ]);
      const expired = rows.filter(
        (row) =>
          row.eventType === "recorder.revoked" &&
          row.targetId === stale.connection.id,
      );
      expect(expired).toEqual([
        expect.objectContaining({
          initiator: { kind: "deployment" },
          payload: {
            connectionId: stale.connection.id,
            via: "web",
            reason: "expired",
            owner: person,
          },
        }),
      ]);
      // Ended once: a second sweep, on this replica or another, finds nothing of this person's.
      await on.expire();
      expect(
        rows.filter(
          (row) =>
            row.eventType === "recorder.revoked" &&
            row.targetId === stale.connection.id,
        ),
      ).toHaveLength(1);
    } finally {
      await database.delete(users).where(eq(users.id, person));
    }
  });

  test("signing out ends every connection the person holds, and nobody else's", async () => {
    const person = await newPerson("leaving");
    const staying = await newPerson("staying");
    const { on, rows } = clocked({ kind: "idle", ms: WEEK });
    try {
      const chrome = await connectOn(on, person, CHROME, "sealed-chrome");
      const edge = await connectOn(on, person, EDGE);
      const theirs = await connectOn(on, staying, CHROME);
      // A code asked for before signing out, and not used yet.
      const pending = await mint(on, person, "web", "sealed-pending");
      expect((await on.revokeAll(person, "signed_out")).sort()).toEqual(
        [chrome.connection.id, edge.connection.id].sort(),
      );
      // It makes no connection afterwards, and the sealed session it held is gone with it.
      expect(
        await on.exchange({
          code: pending.code,
          label: "Chrome",
          extensionId: RECORDER_EXTENSION_ID,
          installId: "a".repeat(32),
        }),
      ).toBeNull();
      expect(
        await database
          .select({ codeHash: recorderConnectCodes.codeHash })
          .from(recorderConnectCodes)
          .where(eq(recorderConnectCodes.userId, person)),
      ).toEqual([]);
      expect(await on.resolve(chrome.token)).toBeNull();
      expect(await on.resolve(edge.token)).toBeNull();
      expect(await sessionOf(chrome.connection.id)).toBeNull();
      expect((await on.resolve(theirs.token))?.userId).toBe(staying);
      expect(
        rows
          .filter((row) => row.eventType === "recorder.revoked")
          .map((row) => [row.targetId, row.actorUserId, row.payload.reason])
          .sort(),
      ).toEqual(
        [
          [chrome.connection.id, person, "signed_out"],
          [edge.connection.id, person, "signed_out"],
        ].sort(),
      );
    } finally {
      await database.delete(users).where(inArray(users.id, [person, staying]));
    }
  });
});
