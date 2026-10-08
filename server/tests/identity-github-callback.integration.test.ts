import { afterAll, expect, test } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore, decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, identityLinks } from "../src/db/schema";
import { githubCallbackRoutes } from "../src/identity/github-callback";
import { sealGithubState } from "../src/identity/github-oauth";
import { createIdentityStore } from "../src/identity/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OK = "https://app.test/settings/connected-accounts?linked=github";
const FAILED = "https://app.test/settings/connected-accounts?linked=failed";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const vault = createCredentialStore(database);
const identity = createIdentityStore(database, vault);
const usedSubjects: string[] = [];
// Each connection stores its token under `${userId}:${githubId}:<uuid>`; tests track the prefix.
const usedKeyPrefixes: string[] = [];

afterAll(async () => {
  if (usedSubjects.length)
    await database
      .delete(identityLinks)
      .where(
        and(
          eq(identityLinks.provider, "github"),
          eq(identityLinks.realm, "github.com"),
          inArray(identityLinks.subject, usedSubjects),
        ),
      );
  if (usedKeyPrefixes.length)
    await database
      .delete(credentials)
      .where(
        or(
          ...usedKeyPrefixes.map((prefix) =>
            like(credentials.keyId, `${prefix}%`),
          ),
        ),
      );
  await database.$client.close();
});

const person = () => `user-${randomUUID()}`;

function githubAccount() {
  const id = randomInt(100_000_000, 1_000_000_000);
  usedSubjects.push(String(id));
  return { id, login: `login-${id}` };
}

function harness(
  account: { id: number; login: string },
  token: string,
  links: Pick<typeof identity, "linkVerified"> = identity,
) {
  const fetchCalls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    if (String(url).includes("access_token")) {
      return Response.json({
        access_token: token,
        refresh_token: `${token}-refresh`,
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      });
    }
    return Response.json(account);
  }) as unknown as typeof fetch;

  const callback = githubCallbackRoutes({
    clientId: "client-id",
    clientSecret: "client-secret-value",
    publicUrl: "https://o.test",
    appUrl: "https://app.test/",
    encryptionKey,
    personIsActive: async () => true,
    credentials: vault,
    identity: links,
    fetchImpl,
  });

  // Runs the callback as `sessionUser`, with a state sealed for `stateUser`.
  async function run(sessionUser: string, stateUser: string) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("actor", { id: sessionUser } as AppVariables["actor"]);
      await next();
    });
    app.route("/", callback);
    const state = await sealGithubState(stateUser, encryptionKey);
    return app.request(
      `/?code=code-${randomUUID()}&state=${encodeURIComponent(state)}`,
    );
  }

  return { run, fetchCalls };
}

const keyId = (userId: string, account: { id: number }) => {
  const value = `${userId}:${account.id}:`;
  usedKeyPrefixes.push(value);
  return value;
};

const credentialsUnder = (prefix: string) =>
  database
    .select()
    .from(credentials)
    .where(like(credentials.keyId, `${prefix}%`));

const linkFor = async (account: { id: number }) => {
  const [row] = await database
    .select()
    .from(identityLinks)
    .where(
      and(
        eq(identityLinks.provider, "github"),
        eq(identityLinks.realm, "github.com"),
        eq(identityLinks.subject, String(account.id)),
      ),
    );
  return row;
};

const credentialById = async (id: string | null | undefined) => {
  const [row] = await database
    .select()
    .from(credentials)
    .where(eq(credentials.id, id ?? ""));
  return row;
};

test("a first connection links the account and stores a live token", async () => {
  const account = githubAccount();
  const user = person();
  keyId(user, account);
  const { run } = harness(account, "gho_first");

  const response = await run(user, user);

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(OK);
  const link = await linkFor(account);
  expect(link).toMatchObject({
    provider: "github",
    realm: "github.com",
    subject: String(account.id),
    userId: user,
    verifiedBy: "oauth",
    handle: account.login,
  });
  const stored = await credentialById(link?.credentialId);
  expect(stored).toMatchObject({
    kind: "connector",
    provider: "github-user-token",
    revokedAt: null,
  });
  const tokens = JSON.parse(
    await decryptSecret(encryptionKey, stored?.encryptedValue ?? ""),
  );
  expect(tokens.accessToken).toBe("gho_first");
});

test("connecting again replaces the credential and revokes the previous one", async () => {
  const account = githubAccount();
  const user = person();
  const prefix = keyId(user, account);

  const first = await harness(account, "gho_one").run(user, user);
  expect(first.headers.get("location")).toBe(OK);
  const firstCredentialId = (await linkFor(account))?.credentialId;

  const second = await harness(account, "gho_two").run(user, user);

  expect(second.status).toBe(302);
  expect(second.headers.get("location")).toBe(OK);
  const link = await linkFor(account);
  expect(link?.credentialId).not.toBe(firstCredentialId);
  const current = await credentialById(link?.credentialId);
  expect(current?.revokedAt).toBeNull();
  const tokens = JSON.parse(
    await decryptSecret(encryptionKey, current?.encryptedValue ?? ""),
  );
  expect(tokens.accessToken).toBe("gho_two");
  expect((await credentialById(firstCredentialId))?.revokedAt).not.toBeNull();
  const live = await database
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(like(credentials.keyId, `${prefix}%`), isNull(credentials.revokedAt)),
    );
  expect(live).toEqual([{ id: link?.credentialId as string }]);
});

test("a reconnect whose link write fails leaves the existing link and its token as they were", async () => {
  const account = githubAccount();
  const user = person();
  const prefix = keyId(user, account);

  const first = await harness(account, "gho_kept").run(user, user);
  expect(first.headers.get("location")).toBe(OK);
  const before = await linkFor(account);

  const failing = harness(account, "gho_lost", {
    linkVerified: async () => {
      throw new Error("database unreachable");
    },
  });
  const response = await failing.run(user, user);

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(FAILED);
  const after = await linkFor(account);
  expect(after).toMatchObject({
    status: "active",
    credentialId: before?.credentialId,
  });
  const kept = await credentialById(before?.credentialId);
  expect(kept?.revokedAt).toBeNull();
  const tokens = JSON.parse(
    await decryptSecret(encryptionKey, kept?.encryptedValue ?? ""),
  );
  expect(tokens.accessToken).toBe("gho_kept");
  const live = (await credentialsUnder(prefix)).filter(
    (row) => row.revokedAt === null,
  );
  expect(live.map((row) => row.id)).toEqual([before?.credentialId as string]);
});

test("an account already linked to someone else fails and revokes the new token", async () => {
  const account = githubAccount();
  const owner = person();
  const intruder = person();
  keyId(owner, account);
  const intruderKey = keyId(intruder, account);

  const claimed = await harness(account, "gho_owner").run(owner, owner);
  expect(claimed.headers.get("location")).toBe(OK);
  const before = await linkFor(account);

  const response = await harness(account, "gho_intruder").run(
    intruder,
    intruder,
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(FAILED);
  const after = await linkFor(account);
  expect(after).toMatchObject({
    userId: owner,
    credentialId: before?.credentialId,
  });
  expect((await credentialById(before?.credentialId))?.revokedAt).toBeNull();
  const stranded = await credentialsUnder(intruderKey);
  expect(stranded).toHaveLength(1);
  expect(stranded[0]?.revokedAt).not.toBeNull();
});

test("a state sealed for another person fails before GitHub is called", async () => {
  const account = githubAccount();
  const starter = person();
  const session = person();
  const starterKey = keyId(starter, account);
  const sessionKey = keyId(session, account);
  const { run, fetchCalls } = harness(account, "gho_never");

  const response = await run(session, starter);

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(FAILED);
  expect(fetchCalls).toEqual([]);
  expect(await linkFor(account)).toBeUndefined();
  expect(await credentialsUnder(starterKey)).toEqual([]);
  expect(await credentialsUnder(sessionKey)).toEqual([]);
});
