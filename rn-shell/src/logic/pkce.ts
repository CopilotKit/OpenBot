/**
 * A PKCE S256 pair for the sign-in hand-off: a random verifier (43 characters of base64url from 32
 * random bytes) and `challenge = base64url(SHA-256(verifier))` with no padding. The verifier stays
 * in memory and is never logged. The random bytes and the hash are passed in, so the pair can be
 * tested against RFC 7636's example without a phone (expo-crypto supplies both in the app).
 */

export type PkcePair = { verifier: string; challenge: string };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const left = bytes.length - index;
  if (left === 1) {
    const n = bytes[index] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** What the server accepts as a verifier: 43 to 128 of `A-Z a-z 0-9 - . _ ~`. */
export const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** A challenge: exactly 43 base64url characters. */
export const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export async function makePkcePair(
  randomBytes: (count: number) => Uint8Array,
  sha256: (text: string) => Promise<Uint8Array>,
): Promise<PkcePair> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(await sha256(verifier));
  if (!VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) throw new Error("pkce-pair-malformed");
  return { verifier, challenge };
}
