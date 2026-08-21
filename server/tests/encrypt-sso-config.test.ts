import { describe, expect, test } from "bun:test";
import { encryptSsoConfig } from "../src/auth/encrypt-sso-config";
import { decryptSecret, encryptSecret } from "../src/credentials";

/**
 * A customer's identity provider client secret, in the column.
 *
 * Better Auth's SSO plugin writes `oidc_config` as plaintext JSON with the OAuth client secret for
 * that company's directory inside it, which is the one secret in this deployment that was not going
 * through `KEY_ENCRYPTION_KEY`. The wrapper is the seam; these are what it has to be true of.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const OIDC_CONFIG = JSON.stringify({
  clientId: "openbot",
  clientSecret: "the-customers-directory-secret",
  discoveryEndpoint: "https://acme.okta.com/.well-known/openid-configuration",
});

/** An adapter that records what it was asked to store, standing in for the database. */
function fakeAdapter() {
  const stored: Record<string, unknown>[] = [];
  let nextRead: Record<string, unknown> | null = null;

  const adapter = {
    create: async (data: Record<string, unknown>) => {
      stored.push(data.data as Record<string, unknown>);
      return data.data;
    },
    update: async (data: Record<string, unknown>) => {
      stored.push(data.update as Record<string, unknown>);
      return data.update;
    },
    findOne: async () => nextRead,
    findMany: async () => (nextRead ? [nextRead] : []),
  };

  return {
    adapter,
    stored,
    holds: (row: Record<string, unknown>) => {
      nextRead = row;
    },
  };
}

function wrap(adapter: ReturnType<typeof fakeAdapter>["adapter"]) {
  // The wrapper takes a factory, because that is what Better Auth is handed.
  return encryptSsoConfig(() => adapter, KEY)({});
}

describe("the identity provider config in the database", () => {
  test("is ciphertext, and the client secret is not in it", async () => {
    const fake = fakeAdapter();
    await wrap(fake.adapter).create({
      model: "ssoProvider",
      data: { providerId: "acme", oidcConfig: OIDC_CONFIG },
    });

    const written = fake.stored[0]?.oidcConfig as string;
    expect(written).not.toContain("the-customers-directory-secret");
    // And it is our envelope, so the same key that reads every other secret here reads this one.
    expect(await decryptSecret(KEY, written)).toBe(OIDC_CONFIG);
  });

  test("comes back in the clear, so the plugin sees what it wrote", async () => {
    const fake = fakeAdapter();
    fake.holds({
      providerId: "acme",
      oidcConfig: await encryptSecret(KEY, OIDC_CONFIG),
    });

    const row = (await wrap(fake.adapter).findOne({
      model: "ssoProvider",
    })) as { oidcConfig: string };

    expect(row.oidcConfig).toBe(OIDC_CONFIG);
  });

  test("a row written before this existed still reads, so an upgrade does not lock anybody out", async () => {
    const fake = fakeAdapter();
    fake.holds({ providerId: "acme", oidcConfig: OIDC_CONFIG });

    const row = (await wrap(fake.adapter).findOne({
      model: "ssoProvider",
    })) as { oidcConfig: string };

    // Plaintext, left alone. Refusing it would take a company's sign-in away at the moment they
    // upgraded, which is a worse outcome than a column that is encrypted from its next write on.
    expect(row.oidcConfig).toBe(OIDC_CONFIG);
  });

  test("a SAML provider's signing config is covered too", async () => {
    const fake = fakeAdapter();
    const samlConfig = JSON.stringify({ privateKey: "-----BEGIN PRIVATE KEY" });
    await wrap(fake.adapter).create({
      model: "ssoProvider",
      data: { providerId: "acme", samlConfig },
    });

    expect(fake.stored[0]?.samlConfig).not.toContain("BEGIN PRIVATE KEY");
  });

  test("every other model passes straight through", async () => {
    // A wrapper that touched user or session rows would be a second, worse copy of the adapter.
    const fake = fakeAdapter();
    await wrap(fake.adapter).create({
      model: "user",
      data: { email: "someone@openbot.test", oidcConfig: "not-a-secret-here" },
    });

    expect(fake.stored[0]?.oidcConfig).toBe("not-a-secret-here");
  });

  test("an already-encrypted value is not encrypted twice", async () => {
    const fake = fakeAdapter();
    const envelope = await encryptSecret(KEY, OIDC_CONFIG);
    await wrap(fake.adapter).create({
      model: "ssoProvider",
      data: { providerId: "acme", oidcConfig: envelope },
    });

    // Double-wrapping would decrypt to an envelope rather than to the config, and the plugin would
    // fail to parse it as JSON on the next sign-in.
    expect(await decryptSecret(KEY, fake.stored[0]?.oidcConfig as string)).toBe(
      OIDC_CONFIG,
    );
  });

  test("a value this key cannot read is dropped rather than handed over as ciphertext", async () => {
    const fake = fakeAdapter();
    const otherKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
    fake.holds({
      providerId: "acme",
      oidcConfig: await encryptSecret(otherKey, OIDC_CONFIG),
    });

    const row = (await wrap(fake.adapter).findOne({
      model: "ssoProvider",
    })) as { oidcConfig: string | null };

    // KEY_ENCRYPTION_KEY changed. Handing the plugin ciphertext would have it try to parse an
    // envelope as an OIDC config; null makes it say the provider is not configured, which is true.
    expect(row.oidcConfig).toBeNull();
  });
});
