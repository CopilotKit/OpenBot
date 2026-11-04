import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { savedLogins, signInRequests } from "../src/db/schema/passwords";
import { createSignInService } from "../src/passwords/service";
import { createPasswordStore } from "../src/passwords/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  liveSecrets,
  purgeSecrets,
  secretValue,
  storedSecret,
  useTestVault,
} from "./support/vault";

/**
 * The store behind the private sign-in form, against a real database and a real vault: every read is
 * the owner's own, two submits racing end in one sign-in, and a saved password is a secret in
 * Intelligence's vault, never a row here.
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
  auditStore: { insert: async (event) => void audit.push(event) },
  gateway: {
    seatFor: async (botId, personId) => personSeat(personId, botId),
    signIn: async () => {
      await new Promise<void>((resolve) => {
        releaseFill = resolve;
      });
      return {
        submitted: true,
        passwordFieldVisible: false,
        codeRequested: false,
        url: "https://example.com/",
      };
    },
    signInCode: async () => {
      throw new Error("not used");
    },
    requestHelp: async () => {
      throw new Error("not used");
    },
  },
});
const actor = { id: owner, userId: owner };

beforeAll(async () => {
  await useTestVault();
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
});
afterAll(async () => {
  // A login a failed test left behind, removed for good.
  await purgeSecrets(
    (await liveSecrets({ kind: "website_login" }))
      .filter((secret) => [owner, stranger].includes(secret.ownerUserId ?? ""))
      .map((secret) => secret.id),
  );
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("a request and a saved login are their owner's alone, and the password is held only in the vault", async () => {
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

  const rows = [
    ...(await store.logins(owner)),
    ...(await store.logins(stranger)),
  ];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.ownerUserId).toBe(owner);
  // The vault holds it encrypted under the organization's key; its record never carries it, and
  // nothing about it is written here.
  const secret = await storedSecret(rows[0]?.id ?? "");
  expect(secret?.encryptionKeyId.length).toBeGreaterThan(0);
  expect(JSON.stringify(secret)).not.toContain(PASSWORD);
  expect(await secretValue(rows[0]?.id ?? "")).toBe(PASSWORD);
  expect(
    await database
      .select()
      .from(savedLogins)
      .where(inArray(savedLogins.ownerUserId, [owner, stranger])),
  ).toEqual([]);
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

/**
 * A site that asks for a verification code after the password. `code_required` is a status the
 * table's check constraint must accept (migration 0056), and an open request the person still sees.
 */
test("a request waiting on its verification code is stored, listed, and then signed in", async () => {
  const codes: string[] = [];
  const mfa = createSignInService({
    store,
    gateway: {
      seatFor: async (botId, personId) => personSeat(personId, botId),
      signIn: async () => ({
        submitted: true,
        passwordFieldVisible: false,
        codeRequested: true,
        url: "https://example.com/mfa",
      }),
      signInCode: async (_botId, input) => {
        codes.push(input.code);
        return {
          submitted: true,
          codeFieldVisible: false,
          passwordFieldVisible: false,
          url: "https://example.com/",
        };
      },
      requestHelp: async () => {
        throw new Error("not used");
      },
    },
  });
  const request = await mfa.request({
    ownerUserId: owner,
    botId: `${prefix}-bot`,
    site: "https://example.com/login",
    actor,
  });
  const waiting = await mfa.submit(owner, request.id, actor, {
    username: "alice",
    password: PASSWORD,
  });
  expect(waiting.status).toBe("code_required");
  expect((await mfa.pending(owner)).map((row) => row.status)).toContain(
    "code_required",
  );
  const done = await mfa.submitCode(owner, request.id, actor, {
    code: "551234",
  });
  expect(done.status).toBe("signed_in");
  expect(codes).toEqual(["551234"]);
  const [stored] = await database
    .select()
    .from(signInRequests)
    .where(inArray(signInRequests.id, [request.id]));
  expect(JSON.stringify(stored)).not.toContain("551234");
  expect(JSON.stringify(stored)).not.toContain(PASSWORD);
});
