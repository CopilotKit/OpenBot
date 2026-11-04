/**
 * A registered identity provider reads back in the clear inside one of Better Auth's transactions.
 *
 * Signing in through a registered OIDC provider, the SSO plugin locks the provider's row and re-reads
 * it through the transaction's own adapter (`lockSSOProviderRow`, then a comparison of the issuer and
 * the OIDC configuration). That adapter was once left unwrapped, so the config came back as what the
 * column holds rather than the configuration, the plugin took it for a provider changed under it, and
 * every such sign-in ended on SSO_PROVIDER_CHANGED. The column holds a vault reference now
 * (auth/sign-in-secrets.ts); the transaction's adapter must reveal it as the outer one does. Against the real Better Auth context and a real database, with transactions
 * off (no SCIM) and on (SCIM configured).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuth } from "../src/auth";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { ssoProviders } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { useTestPeople } from "./support/directory";
import { useTestVault } from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
useTestPeople();
// The configuration is a vault secret the row names (auth/sign-in-secrets.ts).
await useTestVault();
const made: string[] = [];

afterAll(async () => {
  for (const providerId of made)
    await database
      .delete(ssoProviders)
      .where(eq(ssoProviders.providerId, providerId));
  await database.$client.end({ timeout: 5 });
});

function authWith(scim: boolean) {
  if (scim) process.env.SCIM_BEARER_TOKEN = `scim-${randomUUID()}`;
  try {
    return createAuth(
      {
        auth: {
          baseUrl: "http://127.0.0.1:3000",
          secret: "x".repeat(40),
          trustedOrigins: [],
          initialAdminEmails: [],
          allowedEmailDomains: [],
          google: { clientId: "id", clientSecret: "secret" },
        },
        keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      } as unknown as DeploymentConfig,
      database,
      async () => false,
    );
  } finally {
    delete process.env.SCIM_BEARER_TOKEN;
  }
}

describe.each([
  ["without SCIM", false],
  ["with SCIM", true],
])("a provider's row inside a transaction, %s", (_label, scim) => {
  test("reads back decrypted, so the sign-in lock sees the provider it started with", async () => {
    const auth = authWith(scim);
    const { adapter } = await auth.$context;
    const providerId = `tx-${randomUUID()}`;
    made.push(providerId);
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
    // A reference to a vault secret in the column, never the secret.
    const [stored] = await database
      .select({ oidcConfig: ssoProviders.oidcConfig })
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, providerId));
    expect(stored?.oidcConfig).not.toContain("the-secret");
    expect(stored?.oidcConfig).toStartWith("vault:");

    // What lockSSOProviderRow does, through the transaction's adapter.
    const locked = await adapter.transaction(async (trx) => {
      const updated = (await trx.update({
        model: "ssoProvider",
        where: [{ field: "providerId", value: providerId }],
        update: { providerId },
      })) as { oidcConfig?: string } | null;
      const read = (await trx.findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: providerId }],
      })) as { oidcConfig?: string } | null;
      return { updated, read };
    });

    expect(locked.updated?.oidcConfig).toBe(oidcConfig);
    expect(locked.read?.oidcConfig).toBe(oidcConfig);
  });
});
