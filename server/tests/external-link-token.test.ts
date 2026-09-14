import { describe, expect, test } from "bun:test";
import { seal } from "../src/auth/signed-value";
import {
  EXTERNAL_LINK_TTL_MS,
  mintExternalLinkToken,
  readExternalLinkToken,
} from "../src/external/link-token";

const KEY = "external-link-token-test-key";
const NOW = 1_700_000_000_000;
const INVALID = "This Slack link has expired or is invalid.";
const identity = {
  provider: "slack" as const,
  providerTenantId: "T1",
  providerUserId: "U1",
  providerEmail: "person@example.com",
};
const VALID_NONCE = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

async function expectInvalid(token: string, key = KEY, now = NOW) {
  await expect(readExternalLinkToken(token, key, now)).rejects.toThrow(INVALID);
  await expect(readExternalLinkToken(token, key, now)).rejects.toThrowError(
    new Error(INVALID),
  );
}

function forgedClaim(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    issuedAt: NOW,
    expiresAt: NOW + EXTERNAL_LINK_TTL_MS,
    nonce: VALID_NONCE,
    ...overrides,
  };
}

async function sealForgedClaim(overrides: Record<string, unknown> = {}) {
  return seal(JSON.stringify(forgedClaim(overrides)), KEY, "external-link:v1");
}

describe("external Slack link tokens", () => {
  test("opens a live claim to only its provider identity", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    expect(await readExternalLinkToken(token, KEY, NOW)).toEqual(identity);
  });

  test("mints a structurally wider identity as the exact approved claim shape", async () => {
    const identityWithDisplayName = {
      ...identity,
      displayName: "Slack Person",
    };
    const token = await mintExternalLinkToken(
      identityWithDisplayName,
      KEY,
      NOW,
    );

    expect(await readExternalLinkToken(token, KEY, NOW)).toEqual(identity);
  });

  test("expires after its ten minute TTL", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    await expectInvalid(token, KEY, NOW + EXTERNAL_LINK_TTL_MS + 1);
  });

  test("remains valid exactly at its expiry boundary", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    expect(
      await readExternalLinkToken(token, KEY, NOW + EXTERNAL_LINK_TTL_MS),
    ).toEqual(identity);
  });

  test("refuses an altered claim", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);
    const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expectInvalid(altered);
  });

  test("refuses a claim sealed with another key", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    await expectInvalid(token, "another-external-link-token-test-key");
  });

  test.each([
    ["unsealed", "not a sealed value"],
    ["malformed JSON", "{not-json"],
    ["{}", "a sealed value with no claim fields"],
    ["[]", "a sealed array"],
  ])("refuses %s", async (value) => {
    const token =
      value === "unsealed"
        ? "not-a-sealed-value"
        : await seal(value, KEY, "external-link:v1");

    await expectInvalid(token);
  });

  test("requires the Slack provider binding", async () => {
    await expectInvalid(await sealForgedClaim({ provider: "github" }));
  });

  test.each([
    ["providerTenantId", ""],
    ["providerTenantId", "  "],
    ["providerUserId", ""],
    ["providerUserId", "  "],
  ])("refuses an empty %s", async (field, value) => {
    await expectInvalid(await sealForgedClaim({ [field]: value }));
  });

  test.each([
    ["a string issued timestamp", { issuedAt: "now" }],
    ["a string expiry timestamp", { expiresAt: "later" }],
    ["an empty nonce", { nonce: "" }],
    ["a non-string nonce", { nonce: 42 }],
    ["a non-string provider email", { providerEmail: 42 }],
  ])("refuses a malformed claim with %s", async (_reason, overrides) => {
    await expectInvalid(await sealForgedClaim(overrides));
  });

  test("refuses a claim that expires before it was issued", async () => {
    await expectInvalid(await sealForgedClaim({ expiresAt: NOW - 1 }));
  });

  test.each([
    ["a non-UUID nonce", { nonce: "nonce" }, NOW],
    [
      "an issued time after the reader clock",
      { issuedAt: NOW + 1, expiresAt: NOW + EXTERNAL_LINK_TTL_MS + 1 },
      NOW,
    ],
    [
      "a lifetime longer than ten minutes",
      { expiresAt: NOW + EXTERNAL_LINK_TTL_MS + 1 },
      NOW,
    ],
    [
      "a lifetime shorter than ten minutes",
      { expiresAt: NOW + EXTERNAL_LINK_TTL_MS - 1 },
      NOW,
    ],
    [
      "a fractional issued time",
      { issuedAt: NOW + 0.5, expiresAt: NOW + EXTERNAL_LINK_TTL_MS + 0.5 },
      NOW + 1,
    ],
    [
      "a fractional expiry time",
      { expiresAt: NOW + EXTERNAL_LINK_TTL_MS + 0.5 },
      NOW,
    ],
  ])("refuses a forged claim with %s", async (_reason, overrides, readNow) => {
    await expectInvalid(await sealForgedClaim(overrides), KEY, readNow);
  });

  test.each(["openbotUserId", "unexpected"])(
    "refuses a claim with an extra %s key",
    async (key) => {
      await expectInvalid(await sealForgedClaim({ [key]: "forged" }));
    },
  );

  test.each([
    "provider",
    "providerTenantId",
    "providerUserId",
    "providerEmail",
    "issuedAt",
    "expiresAt",
    "nonce",
  ])("refuses a claim missing %s", async (key) => {
    const claim: Record<string, unknown> = forgedClaim();
    delete claim[key];
    const token = await seal(JSON.stringify(claim), KEY, "external-link:v1");

    await expectInvalid(token);
  });

  test("refuses a claim sealed for another domain label", async () => {
    const token = await seal(
      JSON.stringify(forgedClaim()),
      KEY,
      "agent-callback",
    );

    await expectInvalid(token);
  });
});
