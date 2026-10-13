import { generateNonce, sign, type WebBotSigner } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";

/**
 * Signing a Bot's browser requests with the deployment's Web Bot Auth key.
 *
 * The API server holds the key and publishes its public half at
 * `/.well-known/http-message-signatures-directory` (`server/src/web-bot-auth.ts`), then hands the key
 * to each computer alongside the network policy it already pushes. Every request the browser sends
 * then carries three headers, in the form Cloudflare's verifier reads
 * (https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/):
 *
 *   Signature-Agent: "https://openbot.example.com"
 *   Signature-Input: sig1=("@authority" "signature-agent");created=…;keyid="…";alg="ed25519";expires=…;nonce="…";tag="web-bot-auth"
 *   Signature: sig1=:…:
 *
 * `Signature-Agent` is a bare string rather than the dictionary the newer draft uses, because that is
 * what Cloudflare documents and what it verifies. The headers are added inside the browser (see
 * `page-network.ts`), after the request leaves the page and before it reaches the egress filter, so
 * the filter still judges every connection and TLS is still Chromium's own.
 *
 * The key reaching the computer means a Bot's computer can sign as the deployment, which is what it
 * is for. It is a key of its own, derived one way from the deployment key or given separately, so
 * nothing else the deployment holds can be recovered from it, and rotating it is changing
 * `WEB_BOT_AUTH_KEY`.
 */

/** Short, because the signature covers the host and not the request: it is good for any request there. */
const SIGNATURE_LIFETIME_MS = 60_000;

export type WebBotAuthPush = { agent: string; jwk: JsonWebKey };

type Identity = {
  /** The `Signature-Agent` value: the agent URL as a quoted structured-field string. */
  header: string;
  signer: WebBotSigner;
  /** The public key, which is what tells one pushed key from the next. */
  x: string;
};

let current: Identity | null = null;
const listeners = new Set<() => void>();

/** Signing is on. Read on every request, so a push turns it on or off without a restart. */
export function webBotAuthEnabled(): boolean {
  return current !== null;
}

/** Called whenever signing turns on or off, so open pages can follow. */
export function onWebBotAuthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Read the `webBotAuth` member of a policy push. Absent or null is off: an API server that predates
 * Web Bot Auth, or one with it switched off, pushes neither.
 */
export function parseWebBotAuthPush(
  input: unknown,
): { ok: true; push: WebBotAuthPush | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, push: null };
  if (typeof input !== "object") {
    return { ok: false, error: "webBotAuth must be an object." };
  }
  const { agent, jwk } = input as { agent?: unknown; jwk?: unknown };
  let url: URL;
  try {
    url = new URL(String(agent));
  } catch {
    return { ok: false, error: "webBotAuth.agent must be a URL." };
  }
  if (url.protocol !== "https:" || url.origin !== agent) {
    return {
      ok: false,
      error: "webBotAuth.agent must be an https origin with no path.",
    };
  }
  const key = jwk as JsonWebKey | undefined;
  if (
    !key ||
    typeof key !== "object" ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    typeof key.d !== "string" ||
    typeof key.x !== "string"
  ) {
    return {
      ok: false,
      error: "webBotAuth.jwk must be an Ed25519 private key.",
    };
  }
  return { ok: true, push: { agent: url.origin, jwk: key } };
}

/** Install the pushed identity, or with null stop signing. */
export async function setWebBotAuth(
  push: WebBotAuthPush | null,
): Promise<void> {
  if (!push) {
    if (current === null) return;
    current = null;
    for (const listener of listeners) listener();
    return;
  }
  const header = JSON.stringify(push.agent);
  if (current && current.x === push.jwk.x && current.header === header) return;
  const signer = await signerFromJWK({
    kty: "OKP",
    crv: "Ed25519",
    d: push.jwk.d,
    x: push.jwk.x,
  });
  const wasOff = current === null;
  current = { header, signer, x: push.jwk.x as string };
  if (wasOff) for (const listener of listeners) listener();
}

/**
 * Apply what a policy push carried. A malformed member turns signing off and says so, rather than
 * refusing the push: the network policy in the same body has to land whatever happens here.
 */
export async function applyWebBotAuthPush(input: unknown): Promise<void> {
  const parsed = parseWebBotAuthPush(input);
  if (!parsed.ok) {
    console.warn(
      JSON.stringify({
        type: "computer-web-bot-auth-refused",
        error: parsed.error,
      }),
    );
  }
  await setWebBotAuth(parsed.ok ? parsed.push : null);
}

const SIGNATURE_HEADERS = new Set([
  "signature",
  "signature-input",
  "signature-agent",
]);

/**
 * The request's headers with this deployment's signature added, or undefined to leave the request as
 * it is (signing off, or a scheme that has no authority to sign).
 *
 * Any signature headers the page set itself are replaced, so a request never carries two
 * `Signature-Agent` values for a verifier to choose between.
 */
export async function signedHeaders(
  method: string,
  url: string,
  headers: Record<string, string>,
  now: Date = new Date(),
): Promise<{ name: string; value: string }[] | undefined> {
  const identity = current;
  if (!identity) return undefined;
  if (!url.startsWith("https:") && !url.startsWith("http:")) return undefined;
  const fields = await sign(
    {
      kind: "request",
      method,
      targetUri: url,
      fields: [{ name: "signature-agent", value: identity.header }],
    },
    {
      signer: identity.signer,
      created: now,
      expires: new Date(now.getTime() + SIGNATURE_LIFETIME_MS),
      nonce: generateNonce(),
    },
  );
  return [
    ...Object.entries(headers)
      .filter(([name]) => !SIGNATURE_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => ({ name, value })),
    { name: "Signature-Agent", value: identity.header },
    { name: "Signature-Input", value: fields.signatureInput },
    { name: "Signature", value: fields.signature },
  ];
}
