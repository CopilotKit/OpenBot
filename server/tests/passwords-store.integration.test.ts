import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { savedLogins, signInRequests } from "../src/db/schema/passwords";
import { createSignInService } from "../src/passwords/service";
import { createPasswordStore } from "../src/passwords/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The Postgres store behind the private sign-in form, against a real database: every read is the
 * owner's own, two submits racing end in one sign-in, and the stored password is the envelope.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `passwords-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const PASSWORD = "correct-horse-battery-staple-91";
const store = createPasswordStore(database);
const audit: AuditEventInput[] = [];
let releaseFill: (() => void) | undefined;
const service = createSignInService({
  store,
  encryptionKey: Buffer.alloc(32, 3).toString("base64"),
  auditStore: { insert: async (event) => void audit.push(event) },
  gateway: {
    signIn: async () => {
      await new Promise<void>((resolve) => {
        releaseFill = resolve;
      });
      return {
        submitted: true,
        passwordFieldVisible: false,
        url: "https://example.com/",
      };
    },
    requestHelp: async () => {
      throw new Error("not used");
    },
  },
});
const actor = { id: owner, userId: owner };

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("a request and a saved login are their owner's alone, and only the envelope is stored", async () => {
  const request = await service.request({
    ownerUserId: owner,
    botId: `${prefix}-bot`,
    site: "https://example.com/login",
    actor,
  });
  expect(await store.request(stranger, request.id)).toBeNull();
  expect((await service.pending(owner)).map((row) => row.id)).toEqual([
    request.id,
  ]);

  const first = service.submit(owner, request.id, actor, {
    username: "alice",
    password: PASSWORD,
    save: true,
  });
  // The second submit arrives while the first is still being typed, and is refused.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect(
    service.submit(owner, request.id, actor, {
      username: "alice",
      password: PASSWORD,
    }),
  ).rejects.toThrow(/already being entered/);
  releaseFill?.();
  expect((await first).status).toBe("signed_in");

  const rows = await database
    .select()
    .from(savedLogins)
    .where(inArray(savedLogins.ownerUserId, [owner, stranger]));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.encryptedPassword).not.toContain(PASSWORD);
  expect(JSON.parse(rows[0]?.encryptedPassword ?? "{}")).toMatchObject({
    version: 1,
  });
  const [stored] = await database
    .select()
    .from(signInRequests)
    .where(inArray(signInRequests.id, [request.id]));
  expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  expect(JSON.stringify(audit)).not.toContain(PASSWORD);

  expect(await store.deleteLogin(stranger, rows[0]?.id ?? "")).toBe(false);
  expect(
    (await service.deleteLogin(owner, rows[0]?.id ?? "", actor)).deleted,
  ).toBe(true);
});
