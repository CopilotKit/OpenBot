import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { component, verifySignature } from "http-message-sig";
import { signerFromJWK, verifierFromJWK } from "web-bot-auth/crypto";
import { createApp } from "../src/app";
import { pushEgressPolicy } from "../src/computer/policy-network";
import { loadConfig } from "../src/config";
import {
  DIRECTORY_CONTENT_TYPE,
  DIRECTORY_PATH,
  directoryResponse,
  webBotAuthFromEnv,
} from "../src/web-bot-auth";
import { testEnvironment } from "./support/environment";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OTHER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const PUBLIC = "https://openbot.example.com";

function generatedJwk(): JsonWebKey {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
}

const ON = { WEB_BOT_AUTH: "on" };

describe("whether Web Bot Auth is on", () => {
  // A signed request names the deployment to every site a Bot visits, and OpenBot is private by
  // design, so no address, however public, switches it on by itself.
  test.each([
    PUBLIC,
    undefined,
    "http://openbot.example.com",
    "https://localhost:3001",
    "https://10.0.0.5",
    "https://openbot.internal",
  ])("off by default, even for %s", (publicUrl) => {
    expect(
      webBotAuthFromEnv({}, { publicUrl, keyEncryptionKey: KEY }),
    ).toBeUndefined();
  });

  test("off when switched off", () => {
    expect(
      webBotAuthFromEnv(
        { WEB_BOT_AUTH: "off" },
        { publicUrl: PUBLIC, keyEncryptionKey: KEY },
      ),
    ).toBeUndefined();
  });

  test("on when switched on, signing as the public URL", () => {
    expect(
      webBotAuthFromEnv(ON, { publicUrl: PUBLIC, keyEncryptionKey: KEY })
        ?.agent,
    ).toBe(PUBLIC);
  });

  // A verifier has to fetch the key over HTTPS, so anything else would sign with a directory nobody
  // can read.
  test.each([
    "http://openbot.example.com",
    "https://localhost:3001",
    "https://127.0.0.1",
    "https://app.localhost",
    "https://[::1]:3001",
    undefined,
  ])(
    "on with %s, which nobody else can fetch over HTTPS, is refused at start-up",
    (publicUrl) => {
      expect(() =>
        webBotAuthFromEnv(ON, { publicUrl, keyEncryptionKey: KEY }),
      ).toThrow("WEB_BOT_AUTH=on needs an HTTPS address");
    },
  );

  // Only the operator knows whether their verifier can reach a private address.
  test.each([
    "https://10.0.0.5",
    "https://openbot.internal",
    "https://intranet",
  ])("on signs with the private HTTPS address %s", (publicUrl) => {
    expect(
      webBotAuthFromEnv(ON, { publicUrl, keyEncryptionKey: KEY })?.agent,
    ).toBe(publicUrl);
  });

  test("an unknown switch value is refused", () => {
    expect(() =>
      webBotAuthFromEnv(
        { WEB_BOT_AUTH: "yes" },
        { publicUrl: PUBLIC, keyEncryptionKey: KEY },
      ),
    ).toThrow("WEB_BOT_AUTH must be on or off");
  });

  test("reaches the configuration, and stays off without the switch", () => {
    expect(loadConfig(testEnvironment()).webBotAuth).toBeUndefined();
    expect(
      loadConfig(testEnvironment({ OPENBOT_PUBLIC_URL: PUBLIC })).webBotAuth,
    ).toBeUndefined();
    expect(
      loadConfig(testEnvironment({ OPENBOT_PUBLIC_URL: PUBLIC, ...ON }))
        .webBotAuth?.agent,
    ).toBe(PUBLIC);
  });
});

describe("the signing key", () => {
  test("is derived from the deployment key, the same on every replica and restart", () => {
    const first = webBotAuthFromEnv(ON, {
      publicUrl: PUBLIC,
      keyEncryptionKey: KEY,
    });
    const second = webBotAuthFromEnv(ON, {
      publicUrl: PUBLIC,
      keyEncryptionKey: KEY,
    });
    const other = webBotAuthFromEnv(ON, {
      publicUrl: PUBLIC,
      keyEncryptionKey: OTHER_KEY,
    });
    expect(first?.privateJwk).toEqual(second?.privateJwk as JsonWebKey);
    expect(first?.keyid).not.toBe(other?.keyid);
    // One way: the deployment key is not the signing key or anything in the published directory.
    expect(JSON.stringify(first)).not.toContain(KEY.replace(/=+$/, ""));
  });

  test("is WEB_BOT_AUTH_KEY when given", () => {
    const jwk = generatedJwk();
    const identity = webBotAuthFromEnv(
      { ...ON, WEB_BOT_AUTH_KEY: JSON.stringify(jwk) },
      { publicUrl: PUBLIC, keyEncryptionKey: KEY },
    );
    expect(identity?.publicJwk).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: jwk.x,
    });
  });

  test("refuses a key whose public half does not match its private half", () => {
    const jwk = { ...generatedJwk(), x: generatedJwk().x };
    expect(() =>
      webBotAuthFromEnv(
        { ...ON, WEB_BOT_AUTH_KEY: JSON.stringify(jwk) },
        { publicUrl: PUBLIC, keyEncryptionKey: KEY },
      ),
    ).toThrow("does not match");
  });

  test("refuses something that is not an Ed25519 private key, without echoing it", () => {
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ format: "jwk" });
    for (const value of ["not json", JSON.stringify(rsa)]) {
      let message = "";
      try {
        webBotAuthFromEnv(
          { ...ON, WEB_BOT_AUTH_KEY: value },
          { publicUrl: PUBLIC, keyEncryptionKey: KEY },
        );
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("WEB_BOT_AUTH_KEY must be an Ed25519");
      expect(message).not.toContain(value);
    }
  });

  test("is named by its RFC 7638 thumbprint, as the reference signer names it", async () => {
    const identity = webBotAuthFromEnv(ON, {
      publicUrl: PUBLIC,
      keyEncryptionKey: KEY,
    });
    const signer = await signerFromJWK(identity?.privateJwk as JsonWebKey);
    expect(identity?.keyid).toBe(signer.keyid);
  });
});

describe("the key directory", () => {
  const identity = webBotAuthFromEnv(ON, {
    publicUrl: PUBLIC,
    keyEncryptionKey: KEY,
  })!;

  test("publishes the public key and nothing private", async () => {
    const response = await directoryResponse(
      new Request(`${PUBLIC}${DIRECTORY_PATH}`),
      identity,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(DIRECTORY_CONTENT_TYPE);
    const body = (await response.json()) as { keys: JsonWebKey[] };
    expect(body).toEqual({ keys: [identity.publicJwk] });
    expect(JSON.stringify(body)).not.toContain(identity.privateJwk.d as string);
  });

  // What tells a verifier the key was published by the holder of the key: the response is signed
  // over the authority it was fetched from, with the directory tag.
  test("is signed by its own key over the authority it was fetched from", async () => {
    const request = new Request(`${PUBLIC}${DIRECTORY_PATH}`);
    const response = await directoryResponse(request, identity);
    expect(response.headers.get("signature-input")).toContain(
      '("@authority";req)',
    );
    expect(response.headers.get("signature-input")).toContain(
      'tag="http-message-signatures-directory"',
    );
    const verifier = await verifierFromJWK(identity.publicJwk);
    const verified = await verifySignature(
      {
        kind: "response",
        status: response.status,
        fields: [...response.headers].map(([name, value]) => ({
          name,
          value,
        })),
        request: {
          kind: "request",
          method: "GET",
          targetUri: request.url,
          fields: [{ name: "host", value: new URL(PUBLIC).host }],
        },
      },
      {
        policy: {
          algorithms: ["ed25519"],
          requiredComponents: [component("@authority", { req: true })],
          requiredParameters: ["created", "expires", "keyid", "tag"],
        },
        resolveVerifier: (candidate) => {
          expect(candidate.parameters.keyid).toBe(identity.keyid);
          return verifier;
        },
      },
    );
    expect(verified.parameters.tag).toBe("http-message-signatures-directory");
    const { created, expires } = verified.parameters;
    expect((expires as number) - (created as number)).toBe(300);
  });

  test("a signature over one host does not verify for another", async () => {
    const response = await directoryResponse(
      new Request(`${PUBLIC}${DIRECTORY_PATH}`),
      identity,
    );
    const verifier = await verifierFromJWK(identity.publicJwk);
    await expect(
      verifySignature(
        {
          kind: "response",
          status: 200,
          fields: [...response.headers].map(([name, value]) => ({
            name,
            value,
          })),
          request: {
            kind: "request",
            method: "GET",
            targetUri: `https://elsewhere.example${DIRECTORY_PATH}`,
            fields: [{ name: "host", value: "elsewhere.example" }],
          },
        },
        {
          policy: {
            algorithms: ["ed25519"],
            requiredComponents: [component("@authority", { req: true })],
            requiredParameters: ["created", "expires", "keyid", "tag"],
          },
          resolveVerifier: () => verifier,
        },
      ),
    ).rejects.toMatchObject({ code: "VerificationFailed" });
  });

  test("is served at the well-known path when on, and not served when off", async () => {
    const on = createApp(
      loadConfig(testEnvironment({ OPENBOT_PUBLIC_URL: PUBLIC, ...ON })),
    );
    const served = await on.request(`${PUBLIC}${DIRECTORY_PATH}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe(DIRECTORY_CONTENT_TYPE);
    expect(served.headers.get("signature")).toStartWith("sig1=:");

    const off = createApp(loadConfig(testEnvironment()));
    const missing = await off.request(`http://openbot.local${DIRECTORY_PATH}`);
    expect(missing.headers.get("content-type")).not.toBe(
      DIRECTORY_CONTENT_TYPE,
    );
  });
});

describe("handing the key to a computer", () => {
  const identity = webBotAuthFromEnv(ON, {
    publicUrl: PUBLIC,
    keyEncryptionKey: KEY,
  })!;

  async function pushedBody(webBotAuth?: typeof identity) {
    let body: unknown;
    await pushEgressPolicy(
      "http://computer.internal:4100",
      "bot-1",
      { mode: "allow_all", rules: [] },
      {
        ...(webBotAuth ? { webBotAuth } : {}),
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          body = JSON.parse(String(init?.body));
          return new Response("{}");
        }) as unknown as typeof fetch,
      },
    );
    return body as { policy: unknown; webBotAuth?: unknown };
  }

  test("rides the policy push when on", async () => {
    const body = await pushedBody(identity);
    expect(body.policy).toEqual({ mode: "allow_all", rules: [] });
    expect(body.webBotAuth).toEqual({
      agent: PUBLIC,
      jwk: identity.privateJwk,
    });
  });

  // A computer pushed no key stops signing, so switching the deployment off reaches every computer.
  test("is absent when off", async () => {
    const body = await pushedBody();
    expect(body).not.toHaveProperty("webBotAuth");
  });
});
