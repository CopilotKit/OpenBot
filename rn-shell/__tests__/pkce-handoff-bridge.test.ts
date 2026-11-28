import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { parsePageMessage } from "../src/logic/bridge";
import { decideHandoff, ticketFrom } from "../src/logic/handoffConfig";
import { injectedScript } from "../src/logic/injected";
import { base64url, CHALLENGE, makePkcePair, VERIFIER } from "../src/logic/pkce";

describe("PKCE", () => {
  test("RFC 7636 appendix B", async () => {
    const bytes = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83,
      132, 141, 121,
    ]);
    const pair = await makePkcePair(
      () => bytes,
      async (text) => new Uint8Array(createHash("sha256").update(text).digest()),
    );
    expect(pair.verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(pair.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  test("random pairs are well formed", async () => {
    for (let i = 0; i < 50; i += 1) {
      const pair = await makePkcePair(
        (n) => new Uint8Array(randomBytes(n)),
        async (text) => new Uint8Array(createHash("sha256").update(text).digest()),
      );
      expect(VERIFIER.test(pair.verifier)).toBe(true);
      expect(CHALLENGE.test(pair.challenge)).toBe(true);
    }
  });
  test("base64url without padding", () => {
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64url(new Uint8Array([1]))).toBe("AQ");
  });
});

describe("hand-off config (strict)", () => {
  const host = "my.open.bot";
  test("no answer locks, oddities fall back to the web sign-in", () => {
    expect(decideHandoff(null, null, host, true).kind).toBe("unreachable");
    expect(decideHandoff(404, "", host, true)).toEqual({ kind: "webSignIn", reason: "status-404" });
    expect(decideHandoff(200, "not json", host, true).kind).toBe("webSignIn");
    expect(decideHandoff(200, "[]", host, true).kind).toBe("webSignIn");
    expect(decideHandoff(200, '{"handoff":"true"}', host, true)).toEqual({ kind: "webSignIn", reason: "handoff-not-boolean" });
    expect(decideHandoff(200, '{"handoff":false}', host, true)).toEqual({ kind: "webSignIn", reason: "handoff-off" });
    expect(decideHandoff(200, '{"handoff":true}', host, true)).toEqual({ kind: "webSignIn", reason: "callback-missing" });
  });
  test("scheme callback must be exactly openbotshell://signed-in", () => {
    expect(decideHandoff(200, '{"handoff":true,"callback":"scheme","callbackUrl":"openbotshell://signed-in","extra":1}', host, false)).toEqual({ kind: "scheme" });
    expect(decideHandoff(200, '{"handoff":true,"callback":"scheme","callbackUrl":"evil://signed-in"}', host, false).kind).toBe("webSignIn");
  });
  test("https callback on the base host with a path, only where supported", () => {
    const body = '{"handoff":true,"callback":"https","callbackUrl":"https://my.open.bot/api/auth/shell/callback"}';
    expect(decideHandoff(200, body, host, true)).toEqual({
      kind: "https",
      host,
      path: "/api/auth/shell/callback",
      url: "https://my.open.bot/api/auth/shell/callback",
    });
    expect(decideHandoff(200, body, host, false)).toEqual({ kind: "webSignIn", reason: "https-callback-unsupported" });
    expect(decideHandoff(200, '{"handoff":true,"callback":"https","callbackUrl":"https://evil.example/cb"}', host, true).kind).toBe("webSignIn");
    expect(decideHandoff(200, '{"handoff":true,"callback":"https","callbackUrl":"https://my.open.bot/"}', host, true).kind).toBe("webSignIn");
    expect(decideHandoff(200, '{"handoff":true,"callback":"https","callbackUrl":"https://my.open.bot:8443/cb"}', host, true).kind).toBe("webSignIn");
    expect(decideHandoff(200, '{"handoff":true,"callback":"https","callbackUrl":"https://my.open.bot/cb?x=1"}', host, true).kind).toBe("webSignIn");
  });
  test("a ticket only from the expected callback, exactly one, well formed", () => {
    const T = "A".repeat(43);
    expect(ticketFrom(`openbotshell://signed-in?ticket=${T}`, { kind: "scheme" })).toBe(T);
    expect(ticketFrom(`openbotshell://signed-in?ticket=${T}&ticket=${T}`, { kind: "scheme" })).toBeNull();
    expect(ticketFrom("openbotshell://signed-in?ticket=", { kind: "scheme" })).toBeNull();
    expect(ticketFrom("openbotshell://signed-in?ticket=<script>", { kind: "scheme" })).toBeNull();
    expect(ticketFrom("openbotshell://signed-in", { kind: "scheme" })).toBeNull();
    expect(ticketFrom(`openbotshell://other?ticket=${T}`, { kind: "scheme" })).toBeNull();
    expect(ticketFrom(`openbotshell://signed-in.evil?ticket=${T}`, { kind: "scheme" })).toBeNull();
    const https = { kind: "https" as const, host: "my.open.bot", path: "/api/auth/shell/callback", url: "https://my.open.bot/api/auth/shell/callback" };
    expect(ticketFrom(`https://my.open.bot/api/auth/shell/callback?ticket=${T}`, https)).toBe(T);
    expect(ticketFrom(`https://my.open.bot/api/auth/shell/other?ticket=${T}`, https)).toBeNull();
    expect(ticketFrom(`openbotshell://signed-in?ticket=${T}`, https)).toBeNull();
    expect(ticketFrom(`openbotshell://signed-in?ticket=${T}`, null)).toBeNull();
  });
});

describe("bridge messages", () => {
  const origin = "https://my.open.bot";
  const token = "t".repeat(32);
  const msg = (body: object) => JSON.stringify({ ...body, token });
  test("own origin and the token, or nothing", () => {
    expect(parsePageMessage(msg({ kind: "doc" }), "https://my.open.bot/x", origin, token)).toEqual({ kind: "doc", late: false });
    expect(parsePageMessage(msg({ kind: "doc" }), "https://my.open.bot", origin, token)).not.toBeNull();
    expect(parsePageMessage(msg({ kind: "doc" }), "https://evil.example/", origin, token)).toBeNull();
    expect(parsePageMessage(JSON.stringify({ kind: "doc", token: "wrong".repeat(8) }), "https://my.open.bot/", origin, token)).toBeNull();
    expect(parsePageMessage(JSON.stringify({ kind: "doc" }), "https://my.open.bot/", origin, token)).toBeNull();
    expect(parsePageMessage("not json", "https://my.open.bot/", origin, token)).toBeNull();
  });
  test("the web app's messages", () => {
    expect(parsePageMessage(msg({ kind: "bridge", message: { type: "ready" } }), origin, origin, token)).toEqual({ kind: "bridge", message: { type: "ready" } });
    expect(parsePageMessage(msg({ kind: "bridge", message: { type: "route", path: "/bots/b1", tab: "bots", signedIn: true } }), origin, origin, token)).toEqual({
      kind: "bridge",
      message: { type: "route", path: "/bots/b1", tab: "bots", signedIn: true },
    });
    expect(parsePageMessage(msg({ kind: "bridge", message: { type: "route", path: "/x", tab: "evil", signedIn: "yes" } }), origin, origin, token)).toEqual({
      kind: "bridge",
      message: { type: "route", path: "/x", tab: null, signedIn: false },
    });
    expect(parsePageMessage(msg({ kind: "bridge", message: { type: "route", path: "x" } }), origin, origin, token)).toBeNull();
    expect(parsePageMessage(msg({ kind: "bridge", message: { type: "other" } }), origin, origin, token)).toBeNull();
    expect(parsePageMessage(msg({ kind: "chrome", color: "#0D1319", dark: true }), origin, origin, token)).toEqual({ kind: "chrome", color: "#0d1319", dark: true });
    expect(parsePageMessage(msg({ kind: "chrome", color: "red" }), origin, origin, token)).toBeNull();
  });
});

describe("the injected script", () => {
  test("is valid JavaScript, carries the origin and token, and is the same for both moments but for `late`", () => {
    const options = { origin: "https://my.open.bot", platform: "ios" as const, version: "0.1.0", token: "x".repeat(32) };
    const start = injectedScript({ ...options, when: "start" });
    const end = injectedScript({ ...options, when: "end" });
    expect(() => new Function(start)).not.toThrow();
    expect(start).toContain('"https://my.open.bot"');
    expect(start).toContain("late: false");
    expect(end).toContain("late: true");
    expect(start).not.toContain("scrollbar");
    expect(injectedScript({ ...options, platform: "android", when: "start" })).toContain("scrollbar");
  });
});
