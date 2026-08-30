import { seal, unseal } from "../auth/signed-value";

const ASSISTANCE_LABEL = "slack-assistance:v1";
const INVALID_ASSISTANCE_MESSAGE =
  "This assistance link has expired or is invalid.";
export const ASSISTANCE_TTL_MS = 10 * 60_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_KEYS = new Set([
  "openbotUserId",
  "agentId",
  "channelsThreadId",
  "issuedAt",
  "expiresAt",
  "nonce",
]);

export type AssistanceClaim = {
  openbotUserId: string;
  agentId: string;
  channelsThreadId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function invalidAssistance(): never {
  throw new Error(INVALID_ASSISTANCE_MESSAGE);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseAssistanceClaim(raw: string | null): AssistanceClaim | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
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
    const claim = value as Partial<AssistanceClaim>;
    if (
      !nonEmpty(claim.openbotUserId) ||
      !nonEmpty(claim.agentId) ||
      !nonEmpty(claim.channelsThreadId) ||
      typeof claim.issuedAt !== "number" ||
      !Number.isSafeInteger(claim.issuedAt) ||
      typeof claim.expiresAt !== "number" ||
      !Number.isSafeInteger(claim.expiresAt) ||
      claim.expiresAt !== claim.issuedAt + ASSISTANCE_TTL_MS ||
      typeof claim.nonce !== "string" ||
      !UUID_PATTERN.test(claim.nonce)
    ) {
      return null;
    }
    return claim as AssistanceClaim;
  } catch {
    return null;
  }
}

export async function mintAssistanceToken(
  input: Pick<
    AssistanceClaim,
    "openbotUserId" | "agentId" | "channelsThreadId"
  >,
  key: string,
  now = Date.now(),
): Promise<string> {
  return seal(
    JSON.stringify({
      ...input,
      issuedAt: now,
      expiresAt: now + ASSISTANCE_TTL_MS,
      nonce: crypto.randomUUID(),
    } satisfies AssistanceClaim),
    key,
    ASSISTANCE_LABEL,
  );
}

export async function readAssistanceToken(
  token: string | undefined,
  key: string,
  now = Date.now(),
): Promise<AssistanceClaim> {
  try {
    const claim = parseAssistanceClaim(
      await unseal(token, key, ASSISTANCE_LABEL),
    );
    if (!claim || now < claim.issuedAt || now > claim.expiresAt) {
      return invalidAssistance();
    }
    return claim;
  } catch {
    return invalidAssistance();
  }
}
