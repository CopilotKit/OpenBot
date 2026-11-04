// server/tests/sign-in-secrets.integration.test.ts
//
// The secrets Better Auth keeps for signing people in are Intelligence's vault's.
//
// A person's provider tokens and password hash, and a company identity provider's configuration, were
// columns here. They are vault secrets now, the columns hold references, and Better Auth reads back
// exactly what it wrote, through the real Better Auth context and its adapter, against a real
// database and a real Intelligence. An existing deployment's values are moved at boot, verified by
// count (auth/sign-in-secrets-upgrade.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuth } from "../src/auth";
import {
  copySignInSecretsToVault,
  SIGN_IN_SECRETS_COPY_NAME,
  signInValuesLeft,
} from "../src/auth/sign-in-secrets-upgrade";
import type { DeploymentConfig } from "../src/config";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  intelligenceCopies,
  ssoProviders,
  users,
} from "../src/db/schema";
import type { ConnectionsDirectory } from "../src/vault/directory";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { useTestPeople } from "./support/directory";
import { useTestVault } from "./support/vault";

const KEY = Buffer.alloc(32, 7).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);
const person = `sign-in-secrets-${run}`;
const providers: string[] = [];
let vault: ConnectionsDirectory;

const auth = createAuth(
  {
    auth: {
      baseUrl: "http://127.0.0.1:3000",
      secret: "x".repeat(40),
      trustedOrigins: [],
      initialAdminEmails: [],
      allowedEmailDomains: [],
      google: { clientId: "id", clientSecret: "secret" },
    },
    keyEncryptionKey: KEY,
  } as unknown as DeploymentConfig,
  database,
  async () => false,
);

beforeAll(async () => {
  useTestPeople();
  vault = await useTestVault();
  await database.insert(users).values({
    id: person,
    email: `${person}@example.test`,
    name: "Signing In",
  });
});

afterAll(async () => {
  await database.delete(accounts).where(eq(accounts.userId, person));
  await database.delete(users).where(eq(users.id, person));
  if (providers.length > 0)
    await database
      .delete(ssoProviders)
      .where(inArray(ssoProviders.providerId, providers));
  await database
    .delete(intelligenceCopies)
    .where(eq(intelligenceCopies.name, SIGN_IN_SECRETS_COPY_NAME));
  await database.$client.close();
});

const secretOf = (reference: string | null | undefined) =>
  vault.peekSecret(String(reference).slice("vault:".length));

async function column(accountId: string) {
  const [row] = await database
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row;
}

describe("a person's sign-in account", () => {
  test("keeps its tokens and password hash in the vault, and reads back as written", async () => {
    const { adapter } = await auth.$context;
    const created = (await adapter.create({
      model: "account",
      data: {
        userId: person,
        providerId: "google",
        accountId: `google-${run}`,
        accessToken: "access-plain",
        refreshToken: "refresh-plain",
        idToken: "id-plain",
        password: "$scrypt$hash",
      },
    })) as { id: string; refreshToken: string; password: string };
    expect(created.refreshToken).toBe("refresh-plain");

    const row = await column(created.id);
    for (const field of [
      "accessToken",
      "refreshToken",
      "idToken",
      "password",
    ] as const) {
      expect(row?.[field]).toStartWith("vault:");
      expect(secretOf(row?.[field])).toMatchObject({
        ownerUserId: person,
        revokedAt: null,
      });
    }
    expect(secretOf(row?.password)?.kind).toBe("password_hash");
    expect(secretOf(row?.refreshToken)?.kind).toBe("mcp_user_token");

    const read = (await adapter.findOne({
      model: "account",
      where: [{ field: "id", value: created.id }],
    })) as Record<string, string>;
    expect(read).toMatchObject({
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      idToken: "id-plain",
      password: "$scrypt$hash",
    });
    // Revealed in this server, with the person named on the vault's access trail.
    const reads = await vault.client.secrets.accessEvents(
      String(row?.refreshToken).slice("vault:".length),
    );
    expect(reads.some((event) => event.purpose === "sign_in")).toBe(true);

    // A rotated token is a new secret replacing the old one, which the vault revokes.
    await adapter.update({
      model: "account",
      where: [{ field: "id", value: created.id }],
      update: { refreshToken: "refresh-rotated" },
    });
    const after = await column(created.id);
    expect(after?.refreshToken).not.toBe(row?.refreshToken);
    expect(
      (await vault.findSecret(String(row?.refreshToken).slice(6)))?.revokedAt,
    ).not.toBeNull();
    expect(
      (
        (await adapter.findOne({
          model: "account",
          where: [{ field: "id", value: created.id }],
        })) as Record<string, string>
      ).refreshToken,
    ).toBe("refresh-rotated");

    // Removed: every secret the row named is revoked.
    await adapter.delete({
      model: "account",
      where: [{ field: "id", value: created.id }],
    });
    for (const reference of [
      after?.accessToken,
      after?.refreshToken,
      after?.idToken,
      after?.password,
    ])
      expect(
        (await vault.findSecret(String(reference).slice(6)))?.revokedAt,
      ).not.toBeNull();
  });

  test("never lists among the deployment's credentials", async () => {
    const { adapter } = await auth.$context;
    const created = (await adapter.create({
      model: "account",
      data: {
        userId: person,
        providerId: "google",
        accountId: `google-listed-${run}`,
        refreshToken: "refresh-listed",
      },
    })) as { id: string };
    const row = await column(created.id);
    const { createCredentialStore } = await import("../src/credentials");
    const listed = await createCredentialStore(vault).list();
    expect(listed.map((credential) => credential.id)).not.toContain(
      String(row?.refreshToken).slice(6),
    );
  });
});

describe("an identity provider's configuration", () => {
  test("is a vault secret the row names, read back in the clear", async () => {
    const { adapter } = await auth.$context;
    const providerId = `idp-${run}`;
    providers.push(providerId);
    const oidcConfig = JSON.stringify({
      issuer: "https://idp.example.test",
      clientId: "client",
      clientSecret: "the-secret",
    });
    await adapter.create({
      model: "ssoProvider",
      data: {
        providerId,
        issuer: "https://idp.example.test",
        domain: "example.test",
        oidcConfig,
      },
    });
    const [stored] = await database
      .select({ oidcConfig: ssoProviders.oidcConfig })
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, providerId));
    expect(stored?.oidcConfig).toStartWith("vault:");
    expect(secretOf(stored?.oidcConfig)).toMatchObject({
      kind: "mcp_oauth_client",
      ownerUserId: null,
    });
    const read = (await adapter.findOne({
      model: "ssoProvider",
      where: [{ field: "providerId", value: providerId }],
    })) as { oidcConfig: string };
    expect(read.oidcConfig).toBe(oidcConfig);
  });
});

describe("an existing deployment's sign-in secrets, at boot", () => {
  test("move into the vault, verified by count, and read back as they were", async () => {
    await database
      .delete(intelligenceCopies)
      .where(eq(intelligenceCopies.name, SIGN_IN_SECRETS_COPY_NAME));
    // As the release before this one wrote them: values in the columns, an identity provider's
    // configuration encrypted with KEY_ENCRYPTION_KEY, and one from before that in plaintext.
    const accountId = `legacy-${run}`;
    await database.insert(accounts).values({
      id: accountId,
      userId: person,
      providerId: "microsoft",
      accountId: `ms-${run}`,
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      password: "$legacy$hash",
    });
    const sealed = `legacy-sealed-${run}`;
    const plain = `legacy-plain-${run}`;
    providers.push(sealed, plain);
    const sealedConfig = JSON.stringify({ clientSecret: "sealed-secret" });
    await database.insert(ssoProviders).values([
      {
        id: sealed,
        providerId: sealed,
        issuer: "https://sealed.example.test",
        domain: "sealed.example.test",
        oidcConfig: await encryptSecret(KEY, sealedConfig),
      },
      {
        id: plain,
        providerId: plain,
        issuer: "https://plain.example.test",
        domain: "plain.example.test",
        samlConfig: '{"cert":"plain-cert"}',
      },
    ]);
    expect(await signInValuesLeft(database)).toBeGreaterThan(0);

    const outcome = await copySignInSecretsToVault(database, vault, KEY);
    expect(outcome.kind).toBe("copied");
    expect(await signInValuesLeft(database)).toBe(0);

    const row = await column(accountId);
    expect(row?.refreshToken).toStartWith("vault:");
    const { adapter } = await auth.$context;
    expect(
      await adapter.findOne({
        model: "account",
        where: [{ field: "id", value: accountId }],
      }),
    ).toMatchObject({
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      password: "$legacy$hash",
    });
    expect(
      await adapter.findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: sealed }],
      }),
    ).toMatchObject({ oidcConfig: sealedConfig });
    expect(
      await adapter.findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: plain }],
      }),
    ).toMatchObject({ samlConfig: '{"cert":"plain-cert"}' });

    // Recorded: a second boot finds it done and touches nothing.
    expect((await copySignInSecretsToVault(database, vault, KEY)).kind).toBe(
      "done-before",
    );
  });
});
