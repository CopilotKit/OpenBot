import { seal, unseal } from "../auth/signed-value";
import type { ExternalProviderIdentity } from "./schema-types";

export const EXTERNAL_LINK_TTL_MS = 10 * 60_000;

const EXTERNAL_LINK_LABEL = "external-link:v1";
const INVALID_LINK_MESSAGE = "This Slack link has expired or is invalid.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_KEYS = new Set([
  "provider",
  "providerTenantId",
  "providerUserId",
  "providerEmail",
  "issuedAt",
  "expiresAt",
  "nonce",
]);

type ExternalLinkClaim = ExternalProviderIdentity & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function invalidLink(): never {
  throw new Error(INVALID_LINK_MESSAGE);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function asClaim(value: unknown): ExternalLinkClaim | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }

  const keys = Object.keys(value);
  if (
    keys.length !== CLAIM_KEYS.size ||
    keys.some((key) => !CLAIM_KEYS.has(key))
  ) {
    return null;
  }

  const claim = value as Partial<ExternalLinkClaim>;
  const { issuedAt, expiresAt } = claim;
  if (
    claim.provider !== "slack" ||
    !isNonEmptyString(claim.providerTenantId) ||
    !isNonEmptyString(claim.providerUserId) ||
    (claim.providerEmail !== null && typeof claim.providerEmail !== "string") ||
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt !== issuedAt + EXTERNAL_LINK_TTL_MS ||
    !isUuid(claim.nonce)
  ) {
    return null;
  }

  return claim as ExternalLinkClaim;
}

export async function mintExternalLinkToken(
  identity: ExternalProviderIdentity,
  key: string,
  now = Date.now(),
): Promise<string> {
  return seal(
    JSON.stringify({
      provider: identity.provider,
      providerTenantId: identity.providerTenantId,
      providerUserId: identity.providerUserId,
      providerEmail: identity.providerEmail,
      issuedAt: now,
      expiresAt: now + EXTERNAL_LINK_TTL_MS,
      nonce: crypto.randomUUID(),
    } satisfies ExternalLinkClaim),
    key,
    EXTERNAL_LINK_LABEL,
  );
}

export async function readExternalLinkToken(
  token: string | undefined,
  key: string,
  now = Date.now(),
): Promise<ExternalProviderIdentity> {
  try {
    const unsealed = await unseal(token, key, EXTERNAL_LINK_LABEL);
    if (!unsealed) return invalidLink();

    const claim = asClaim(JSON.parse(unsealed));
    if (!claim || now < claim.issuedAt || now > claim.expiresAt) {
      return invalidLink();
    }

    return {
      provider: claim.provider,
      providerTenantId: claim.providerTenantId,
      providerUserId: claim.providerUserId,
      providerEmail: claim.providerEmail,
    };
  } catch {
    return invalidLink();
  }
}
