import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A value this deployment can hand out and later recognise as its own.
 *
 * Used for statements that travel through something we do not control and come back: a run assertion
 * carried by a customer's own agent process, for instance. The alternative is a row per statement,
 * which buys nothing here because these are short-lived and single-purpose, and costs a write and a
 * read on a path that already has both.
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
