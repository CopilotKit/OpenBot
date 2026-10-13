import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
} from "node:crypto";
import { component, createSignature } from "http-message-sig";
import { generateNonce, HTTP_MESSAGE_SIGNATURES_DIRECTORY } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";

/**
 * Web Bot Auth: a Bot's browser says, cryptographically, which deployment it browses for.
 *
 * The protocol is Cloudflare's signed agents (https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/),
 * built on HTTP Message Signatures (RFC 9421). The deployment holds one Ed25519 key, publishes its
 * public half at `/.well-known/http-message-signatures-directory`, and every request a Bot's browser
 * makes carries `Signature-Agent`, `Signature-Input` and `Signature` (signed in agent-computer, see
 * `agent-computer/src/web-bot-auth.ts`). A site behind Cloudflare that allows signed agents lets the
 * request through instead of challenging it; one that does not is unaffected. It is how OpenAI's
 * agent identifies itself, and the honest alternative to looking like a person.
 *
 * Signing alone earns nothing until the deployment is registered with Cloudflare, which is a manual
 * step: see docs/configuration.md.
 */

export const DIRECTORY_PATH = HTTP_MESSAGE_SIGNATURES_DIRECTORY;
export const DIRECTORY_CONTENT_TYPE =
  "application/http-message-signatures-directory+json";

/**
 * How long a directory signature is good for. Each fetch is signed afresh, so this only has to
 * outlive a cache between the deployment and the verifier.
 */
const DIRECTORY_SIGNATURE_TTL_SECONDS = 300;

export type WebBotAuth = {
  /** `https://host`, the value Bots send in `Signature-Agent`; the directory lives under it. */
  agent: string;
  /** Full private key. Sent to this deployment's computers so they can sign; never logged. */
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  /** RFC 7638 thumbprint, the `keyid` every signature names. */
  keyid: string;
};

/** The private seed derived from the deployment key, when no key is given explicitly. */
function derivedSeed(keyEncryptionKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(keyEncryptionKey, "base64"),
      Buffer.alloc(0),
      Buffer.from("openbot web-bot-auth ed25519 v1"),
      32,
    ),
  );
}

/** PKCS#8 for an Ed25519 seed: the fixed RFC 8410 prefix followed by the 32 bytes. */
function ed25519FromSeed(seed: Buffer): JsonWebKey {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }).export({
    format: "jwk",
  }) as JsonWebKey;
}

function parseJwk(raw: string): JsonWebKey {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new Error(
      "WEB_BOT_AUTH_KEY must be an Ed25519 private key as a JSON Web Key.",
    );
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) {
    throw new Error(
      "WEB_BOT_AUTH_KEY must be an Ed25519 private key (kty OKP, crv Ed25519, with d and x).",
    );
  }
  // Refuse a pair whose halves do not match, which would publish a key nothing signs with.
  const derived = createPublicKey(
    createPrivateKey({ key: jwk, format: "jwk" }),
  ).export({ format: "jwk" }) as JsonWebKey;
  if (derived.x !== jwk.x) {
    throw new Error("WEB_BOT_AUTH_KEY's x does not match its d.");
  }
  return { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x };
}

/** RFC 7638: SHA-256 over the required members in lexical order, base64url. Cloudflare's `keyid`. */
function thumbprint(x: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
    .digest("base64url");
}

/**
 * The origin a verifier fetches the directory from, or undefined for anything that is not https or
 * is this machine, where no verifier could ever read it.
 */
function httpsOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  ) {
    return undefined;
  }
  return parsed.origin;
}

/**
 * The deployment's Web Bot Auth identity, or undefined when it is off.
 *
 * Off unless `WEB_BOT_AUTH=on`. A signed request names the deployment's URL to every site a Bot
 * visits, and an OpenBot deployment is private by design, so signing is the operator's deliberate
 * choice, never inferred from the address. `on` needs an https `OPENBOT_PUBLIC_URL` (else
 * `BETTER_AUTH_URL`) that is not this machine, because that is where verifiers fetch the key; it is
 * refused for plain http or loopback rather than signing with a directory nobody can read.
 *
 * The key is `WEB_BOT_AUTH_KEY` (an Ed25519 private JWK) when given, otherwise derived from
 * `KEY_ENCRYPTION_KEY` with HKDF, so every replica and every restart signs with the same key and a
 * deployment needs no new secret to start.
 */
export function webBotAuthFromEnv(
  environment: Record<string, string | undefined>,
  options: { publicUrl: string | undefined; keyEncryptionKey: string },
): WebBotAuth | undefined {
  const switchValue = environment.WEB_BOT_AUTH?.trim().toLowerCase() || "";
  if (switchValue && switchValue !== "on" && switchValue !== "off") {
    throw new Error(
      `WEB_BOT_AUTH must be on or off, not ${JSON.stringify(environment.WEB_BOT_AUTH)}.`,
    );
  }
  if (switchValue !== "on") return undefined;
  const agent = httpsOrigin(options.publicUrl);
  if (!agent) {
    throw new Error(
      "WEB_BOT_AUTH=on needs an HTTPS address in OPENBOT_PUBLIC_URL (or BETTER_AUTH_URL) other than this machine, where verifiers fetch the signing key.",
    );
  }
  const explicit = environment.WEB_BOT_AUTH_KEY?.trim();
  const privateJwk = explicit
    ? parseJwk(explicit)
    : ed25519FromSeed(derivedSeed(options.keyEncryptionKey));
  const publicJwk: JsonWebKey = {
    kty: "OKP",
    crv: "Ed25519",
    x: privateJwk.x as string,
  };
  return {
    agent,
    privateJwk,
    publicJwk,
    keyid: thumbprint(privateJwk.x as string),
  };
}

/**
 * `GET /.well-known/http-message-signatures-directory`: the public key, signed.
 *
 * The response carries its own signature over `("@authority";req)` with the
 * `http-message-signatures-directory` tag, which is how a verifier knows the key was published by
 * the holder of the key and not merely placed on the host.
 */
export async function directoryResponse(
  request: Request,
  identity: WebBotAuth,
  now: Date = new Date(),
): Promise<Response> {
  const body = JSON.stringify({ keys: [identity.publicJwk] });
  const authority = request.headers.get("host") ?? new URL(request.url).host;
  const created = Math.floor(now.getTime() / 1000);
  const signer = await signerFromJWK(identity.privateJwk);
  const fields = await createSignature(
    {
      kind: "response",
      status: 200,
      fields: [{ name: "content-type", value: DIRECTORY_CONTENT_TYPE }],
      request: {
        kind: "request",
        method: "GET",
        targetUri: `https://${authority}${DIRECTORY_PATH}`,
        fields: [{ name: "host", value: authority }],
      },
    },
    {
      label: "sig1",
      components: [component("@authority", { req: true })],
      parameters: {
        alg: "ed25519",
        keyid: identity.keyid,
        created,
        expires: created + DIRECTORY_SIGNATURE_TTL_SECONDS,
        nonce: generateNonce(),
        tag: "http-message-signatures-directory",
      },
      signer,
    },
  );
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": DIRECTORY_CONTENT_TYPE,
      "cache-control": "public, max-age=60",
      signature: fields.signature,
      "signature-input": fields.signatureInput,
    },
  });
}
