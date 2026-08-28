import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret } from "../credentials";

/**
 * A value this deployment can hand out and later recognise as its own.
 *
 * Used for statements that travel through something we do not control and come back: a run assertion
 * carried by a customer's own agent process, for instance. The alternative is a row per statement,
 * which buys nothing here because these are short-lived and single-purpose, and costs a write and a
 * read on a path that already has both.
 *
 * Two shapes, and the difference between them is the whole point of this module. A SIGNED value is
 * authenticated and readable: anybody holding it can read what it says, and only this deployment can
 * make another one. A SEALED value is authenticated and unreadable: nobody without the key learns
 * anything from holding it. Which one a statement needs is decided by what is inside it — a signed
 * value is right for a claim that is public anyway, and is wrong the moment the statement carries a
 * secret of its own.
 */

/**
 * The key a signature is made with.
 *
 * Derived from the deployment's encryption key rather than being the encryption key, and derived
 * under a label, so a signature here can never be confused with a credential ciphertext there. One
 * secret to configure, two uses that cannot borrow each other's material.
 */
function signingKey(encryptionKey: string, label: string): Buffer {
  return createHmac("sha256", encryptionKey).update(label).digest();
}

/**
 * A value and its signature, in one string.
 *
 * The label separates uses, so a signature valid for one kind of statement can never be replayed as
 * another kind.
 */
export function sign(
  value: string,
  encryptionKey: string,
  label: string,
): string {
  const signature = createHmac("sha256", signingKey(encryptionKey, label))
    .update(value)
    .digest("base64url");
  return `${value}.${signature}`;
}

/**
 * The value a signed string carries, or nothing.
 *
 * Compared in constant time. A comparison that returns early leaks how much of a signature was
 * right, which is enough to construct a valid one given patience.
 */
export function verify(
  signed: string | undefined,
  encryptionKey: string,
  label: string,
): string | null {
  if (!signed) return null;
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;

  const value = signed.slice(0, separator);
  const expected = sign(value, encryptionKey, label);
  const given = Buffer.from(signed);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return null;
  return timingSafeEqual(given, wanted) ? value : null;
}

/**
 * The key a value is sealed with.
 *
 * Derived like a signing key and under a distinguished prefix, so the same deployment secret gives
 * this use its own material: a sealing key is never a signing key, and neither is the key the
 * credential vault encrypts with. AES-256 wants 32 bytes and an HMAC-SHA256 digest is exactly that,
 * base64 because {@link encryptSecret} takes its key that way.
 */
function sealingKey(encryptionKey: string, label: string): string {
  return createHmac("sha256", encryptionKey)
    .update(`seal:${label}`)
    .digest("base64");
}

/**
 * A value nobody but this deployment can read, in one URL-safe string.
 *
 * AES-256-GCM, through the same helper the credential vault uses rather than a second crypto
 * implementation to keep right. GCM authenticates as well as encrypts, so a sealed value needs no
 * signature around it: a tampered one fails to decrypt rather than decrypting to something else.
 *
 * The label separates uses exactly as it does for a signature, but here it does so through the key —
 * a value sealed for one purpose is not merely rejected by another, it cannot be opened by it at all.
 *
 * base64url over the envelope, because this is for values that travel as a query parameter and the
 * envelope itself is JSON with base64 inside it. Sealing says nothing about freshness: a caller that
 * needs an expiry puts one INSIDE the value and checks it after opening.
 */
export async function seal(
  value: string,
  encryptionKey: string,
  label: string,
): Promise<string> {
  const envelope = await encryptSecret(sealingKey(encryptionKey, label), value);
  return Buffer.from(envelope, "utf8").toString("base64url");
}

/**
 * The value a sealed string carries, or nothing.
 *
 * One answer for every way of being unopenable — not base64url, not an envelope, sealed under
 * another label, sealed by somebody else, altered by a byte — because there is exactly one thing to
 * do with a value this deployment cannot read, and a caller that has to tell those apart is a caller
 * that can get one of them wrong.
 */
export async function unseal(
  sealed: string | undefined,
  encryptionKey: string,
  label: string,
): Promise<string | null> {
  if (!sealed) return null;
  try {
    return await decryptSecret(
      sealingKey(encryptionKey, label),
      Buffer.from(sealed, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
}
