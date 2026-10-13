import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import {
  parseWebBotAuthPush,
  setWebBotAuth,
  signedHeaders,
  webBotAuthEnabled,
} from "../src/web-bot-auth";

const AGENT = "https://openbot.example.com";
const jwk = generateKeyPairSync("ed25519").privateKey.export({
  format: "jwk",
});
const publicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };

afterEach(async () => {
  await setWebBotAuth(null);
});

/** Verify the way a site does: with the reference verifier and the key from the directory. */
async function verified(
  url: string,
  headers: { name: string; value: string }[],
) {
  const verifier = await verifierFromJWK(publicJwk);
  return verify(
    new Request(url, {
      headers: headers.map(
        ({ name, value }) => [name, value] as [string, string],
      ),
    }),
    {
      resolver: (candidate) => {
        if (candidate.keyid !== verifier.keyid) throw new Error("unknown key");
        return verifier;
      },
    },
  );
}

describe("a policy push's webBotAuth member", () => {
  test("absent or null is off", () => {
    expect(parseWebBotAuthPush(undefined)).toEqual({ ok: true, push: null });
    expect(parseWebBotAuthPush(null)).toEqual({ ok: true, push: null });
  });

  test("an https origin and an Ed25519 private key is accepted", () => {
    expect(parseWebBotAuthPush({ agent: AGENT, jwk })).toEqual({
      ok: true,
      push: { agent: AGENT, jwk },
    });
  });

  test.each([
    [{ agent: "http://openbot.example.com", jwk }, "https origin"],
    [{ agent: `${AGENT}/path`, jwk }, "https origin"],
    [{ agent: "not a url", jwk }, "must be a URL"],
    [{ agent: AGENT, jwk: publicJwk }, "Ed25519 private key"],
    [{ agent: AGENT, jwk: { ...jwk, crv: "X25519" } }, "Ed25519 private key"],
    ["a string", "must be an object"],
  ])("refuses %j", (input, error) => {
    const parsed = parseWebBotAuthPush(input);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });
});

describe("signing a request", () => {
  test("leaves requests alone while off", async () => {
    expect(webBotAuthEnabled()).toBe(false);
    expect(
      await signedHeaders("GET", "https://chatgpt.com/", { accept: "*/*" }),
    ).toBeUndefined();
  });

  test("adds a signature the reference verifier accepts, in Cloudflare's form", async () => {
    await setWebBotAuth({ agent: AGENT, jwk });
    expect(webBotAuthEnabled()).toBe(true);
    const now = new Date();
    const headers = await signedHeaders(
      "GET",
      "https://chatgpt.com/c/123?x=1",
      { accept: "text/html", cookie: "session=kept" },
      now,
    );
    expect(headers).toBeDefined();
    const byName = Object.fromEntries(
      (headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]),
    );
    // The page's own headers are kept, cookies included.
    expect(byName.cookie).toBe("session=kept");
    expect(byName.accept).toBe("text/html");
    // A bare string, which is what Cloudflare documents, not the newer dictionary form.
    expect(byName["signature-agent"]).toBe(`"${AGENT}"`);
    expect(byName["signature-input"]).toStartWith(
      'sig1=("@authority" "signature-agent");',
    );
    expect(byName["signature-input"]).toContain('tag="web-bot-auth"');
    expect(byName["signature-input"]).toContain('alg="ed25519"');

    const result = await verified(
      "https://chatgpt.com/c/123?x=1",
      headers ?? [],
    );
    expect(result.signatureAgent?.uri).toBe(AGENT);
    expect(result.expires.getTime() - result.created.getTime()).toBe(60_000);
    expect(result.nonce).toBeString();
  });

  test("a signature for one host does not verify for another", async () => {
    await setWebBotAuth({ agent: AGENT, jwk });
    const headers = await signedHeaders("GET", "https://chatgpt.com/", {});
    await expect(
      verified("https://evil.example/", headers ?? []),
    ).rejects.toThrow();
  });

  test("covers the port when the URL names one", async () => {
    await setWebBotAuth({ agent: AGENT, jwk });
    const headers = await signedHeaders("GET", "http://127.0.0.1:8080/x", {});
    await verified("http://127.0.0.1:8080/x", headers ?? []);
    await expect(
      verified("http://127.0.0.1:8081/x", headers ?? []),
    ).rejects.toThrow();
  });

  // A page can set these on a fetch itself. Two Signature-Agent values would leave a verifier
  // choosing between them.
  test("replaces signature headers the page set", async () => {
    await setWebBotAuth({ agent: AGENT, jwk });
    const headers = await signedHeaders("POST", "https://chatgpt.com/", {
      Signature: "sig1=:forged:",
      "signature-agent": '"https://someone-else.example"',
    });
    const agents = (headers ?? []).filter(
      ({ name }) => name.toLowerCase() === "signature-agent",
    );
    expect(agents).toEqual([{ name: "Signature-Agent", value: `"${AGENT}"` }]);
    expect(
      (headers ?? []).filter(({ name }) => name.toLowerCase() === "signature"),
    ).toHaveLength(1);
  });

  test.each([
    "data:text/html,hi",
    "blob:https://chatgpt.com/1",
    "chrome://version",
  ])("leaves %s alone, which has no authority to sign", async (url) => {
    await setWebBotAuth({ agent: AGENT, jwk });
    expect(await signedHeaders("GET", url, {})).toBeUndefined();
  });

  test("stops when a push carries no key", async () => {
    await setWebBotAuth({ agent: AGENT, jwk });
    await setWebBotAuth(null);
    expect(
      await signedHeaders("GET", "https://chatgpt.com/", {}),
    ).toBeUndefined();
  });

  test("never puts the private key in a header", async () => {
    await setWebBotAuth({ agent: AGENT, jwk });
    const headers = await signedHeaders("GET", "https://chatgpt.com/", {});
    expect(JSON.stringify(headers)).not.toContain(jwk.d as string);
  });
});
