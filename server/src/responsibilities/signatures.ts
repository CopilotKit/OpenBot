/**
 * Each vendor's own documented signature scheme, over the raw request bytes, compared in constant
 * time. Nothing here parses JSON before the signature is checked except where the vendor itself
 * signs a parsed form (Sentry signs `JSON.stringify(body)`).
 *
 * Sources:
 *  - GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`.
 *  - Linear: `Linear-Signature: <hex HMAC-SHA256(signing secret, raw body)>`; payload
 *    `webhookTimestamp` (ms) within one minute (https://linear.app/developers/webhooks).
 *  - Sentry: `Sentry-Hook-Signature: <hex HMAC-SHA256(client secret, JSON.stringify(body))>`
 *    (https://docs.sentry.io/organization/integrations/integration-platform/webhooks/).
 *  - PagerDuty v3: `X-PagerDuty-Signature: v1=<hex HMAC-SHA256(secret, raw body)>[, v1=…]`; any one
 *    matching passes, for rotation (https://docs.pagerduty.com/developer/verifying-webhook-signatures).
 *  - Standard Webhooks (generic webhook HMAC mode): `webhook-signature: v1,<base64 HMAC-SHA256(
 *    base64decode(secret without whsec_), "{webhook-id}.{webhook-timestamp}.{body}")>` space
 *    separated; timestamp within five minutes (https://www.standardwebhooks.com/).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}
function hexHmac(secret: string | Buffer, content: string) {
  return createHmac("sha256", secret).update(content, "utf8").digest();
}
function fromHex(value: string) {
  return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

export function verifyGithubSignature(
  secret: string,
  raw: string,
  header: string | undefined,
) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
  const supplied = match?.[1] ? fromHex(match[1]) : null;
  return !!supplied && safeEqual(supplied, hexHmac(secret, raw));
}

export function verifyLinearSignature(
  secret: string,
  raw: string,
  header: string | undefined,
) {
  const supplied = fromHex(header?.trim() ?? "");
  return !!supplied && safeEqual(supplied, hexHmac(secret, raw));
}
/** Linear's replay guard: `webhookTimestamp` is milliseconds and must be within a minute. */
export function linearTimestampFresh(
  webhookTimestamp: unknown,
  now = Date.now(),
) {
  return (
    typeof webhookTimestamp === "number" &&
    Number.isFinite(webhookTimestamp) &&
    Math.abs(now - webhookTimestamp) <= 60_000
  );
}

/**
 * Sentry's reference implementation hashes `JSON.stringify(request.body)`. Sentry sends compact
 * JSON, so the raw bytes normally are that string; the re-serialized form is also accepted so a
 * proxy that re-encodes whitespace does not break verification.
 */
export function verifySentrySignature(
  secret: string,
  raw: string,
  header: string | undefined,
) {
  const supplied = fromHex(header?.trim() ?? "");
  if (!supplied) return false;
  if (safeEqual(supplied, hexHmac(secret, raw))) return true;
  try {
    const reserialized = JSON.stringify(JSON.parse(raw));
    return (
      reserialized !== raw && safeEqual(supplied, hexHmac(secret, reserialized))
    );
  } catch {
    return false;
  }
}

export function verifyPagerDutySignature(
  secret: string,
  raw: string,
  header: string | undefined,
) {
  const expected = hexHmac(secret, raw);
  let matched = false;
  for (const part of (header ?? "").split(",")) {
    const match = /^v1=([0-9a-f]{64})$/i.exec(part.trim());
    const supplied = match?.[1] ? fromHex(match[1]) : null;
    // Every candidate is compared, so timing does not reveal which position matched.
    if (supplied && safeEqual(supplied, expected)) matched = true;
  }
  return matched;
}

export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
export function verifyStandardWebhook(
  secret: string,
  raw: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp))
    return false;
  if (
    Math.abs(nowSeconds - Number(timestamp)) >
    STANDARD_WEBHOOK_TOLERANCE_SECONDS
  )
    return false;
  const key = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice(6) : secret,
    "base64",
  );
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${raw}`, "utf8")
    .digest();
  let matched = false;
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    const supplied = Buffer.from(value, "base64");
    if (safeEqual(supplied, expected)) matched = true;
  }
  return matched;
}

/** `Authorization: Bearer <secret>`, constant-time over digests so length is not revealed. */
export function verifyBearer(secret: string, header: string | undefined) {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!match?.[1]) return false;
  const digest = (value: string) =>
    createHmac("sha256", "openbot-bearer").update(value).digest();
  return safeEqual(digest(match[1]), digest(secret));
}
