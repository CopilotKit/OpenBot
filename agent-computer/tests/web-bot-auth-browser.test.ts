import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import {
  setEgressPolicy,
  setEgressResolver,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";
import { setWebBotAuth } from "../src/web-bot-auth";

/**
 * A Bot's real browser signs what it sends, and nothing else about it changes.
 *
 * Launched through the real profile path with the egress filter in front of it, as on a computer. A
 * site on this machine records every request and checks its signature with the reference verifier,
 * the way a site behind Cloudflare would. What it proves beyond the unit tests: the DevTools `Fetch`
 * interception reaches navigations, redirects, subresources, cross-origin fetches, a cross-site frame
 * (its own process when headed), dedicated workers, and a service worker's script and its own fetches;
 * cookies still go out; no CORS preflight appears; a headless
 * browser no longer says `HeadlessChrome`; and the filter still refuses what the policy refuses,
 * signed or not.
 *
 * Asked for by name, like `webrtc-proxy.test.ts`: it launches a real Chromium.
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 COMPUTER_BROWSER_MODE=headless bun test tests/web-bot-auth-browser.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const AGENT = "https://openbot.example.com";

type Seen = {
  path: string;
  method: string;
  cookie: string | null;
  userAgent: string;
  clientHints: string | null;
  verified: string | null;
};

describe.skipIf(!asked)("Web Bot Auth from a Bot's browser", () => {
  test("signs every request the page makes, and the filter still decides", async () => {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({
      format: "jwk",
    });
    const verifier = await verifierFromJWK({
      kty: "OKP",
      crv: "Ed25519",
      x: jwk.x,
    });
    const seen: Seen[] = [];
    const record = async (request: Request) => {
      let verified: string | null = null;
      try {
        const result = await verify(request, {
          resolver: (candidate) => {
            if (candidate.keyid !== verifier.keyid)
              throw new Error("unknown key");
            return verifier;
          },
        });
        verified = result.signatureAgent?.uri ?? "no agent";
      } catch {
        verified = null;
      }
      seen.push({
        path: new URL(request.url).pathname,
        method: request.method,
        cookie: request.headers.get("cookie"),
        userAgent: request.headers.get("user-agent") ?? "",
        clientHints: request.headers.get("sec-ch-ua"),
        verified,
      });
    };
    const html = (body: string) =>
      new Response(`<!doctype html><body>${body}</body>`, {
        headers: { "content-type": "text/html" },
      });
    let refusedReached = 0;
    const refused = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        refusedReached += 1;
        return new Response("should never be reached", {
          headers: { "access-control-allow-origin": "*" },
        });
      },
    });
    const crossOrigin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await record(request);
        if (new URL(request.url).pathname === "/frame")
          return html(
            `<script>fetch("/from-frame").then(() => parent.postMessage("frame", "*"))</script>`,
          );
        return new Response("cross-origin", {
          headers: { "access-control-allow-origin": "*" },
        });
      },
    });
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await record(request);
        const path = new URL(request.url).pathname;
        if (path === "/set-cookie")
          return new Response("set", {
            headers: { "set-cookie": "session=kept; Path=/" },
          });
        if (path === "/redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "/landing" },
          });
        if (path === "/worker.js")
          return new Response(
            `fetch("/from-worker").then(() => postMessage("done"))`,
            { headers: { "content-type": "text/javascript" } },
          );
        if (path === "/sw.js")
          return new Response(
            `self.addEventListener("install", () => self.skipWaiting());
             self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));
             self.addEventListener("fetch", (event) => {
               if (new URL(event.request.url).pathname === "/through-worker")
                 event.respondWith(fetch("/from-service-worker"));
             });`,
            { headers: { "content-type": "text/javascript" } },
          );
        if (path === "/")
          return html(`<script>
            window.results = {};
            const settle = (name, promise) => promise.then(
              (value) => (results[name] = value),
              (error) => (results[name] = "failed: " + error),
            );
            settle("crossOrigin", fetch("http://127.0.0.1:${crossOrigin.port}/cors").then((r) => r.text()));
            settle("refused", fetch("http://127.0.0.1:${refused.port}/nope").then((r) => r.status));
            settle("worker", new Promise((resolve) => {
              const worker = new Worker("/worker.js");
              worker.onmessage = () => resolve("done");
            }));
            settle("serviceWorker", navigator.serviceWorker.register("/sw.js")
              .then(() => navigator.serviceWorker.ready)
              .then(() => new Promise((resolve) => setTimeout(resolve, 500)))
              .then(() => fetch("/through-worker"))
              .then((r) => r.text()));
            settle("frame", new Promise((resolve) => {
              addEventListener("message", (event) => event.data === "frame" && resolve("done"));
            }));
          </script>
          <iframe src="http://frame.test:${crossOrigin.port}/frame"></iframe>`);
        return new Response(path);
      },
    });

    await startEgressFilter({ env: {} });
    // Another site for the frame, so a headed browser puts it in a process of its own. The browser
    // hands the name to the proxy unresolved, and the filter resolves it here.
    setEgressResolver(async (host) => {
      if (host === "frame.test") return ["127.0.0.1"];
      throw new Error(`no such host ${host}`);
    });
    const { createProfiles } = await import("../src/profiles");
    const root = await mkdtemp(join(tmpdir(), "openbot-web-bot-auth-"));
    const profiles = createProfiles(root);
    const bot = "web-bot-auth-test";
    // The site and the cross-origin server are allowed; the third server is not.
    setEgressPolicy(bot, {
      mode: "allowlist_only",
      rules: [
        {
          type: "cidr",
          value: "127.0.0.1/32",
          ports: `${site.port},${crossOrigin.port}`,
        },
      ],
    });
    await setWebBotAuth({ agent: AGENT, jwk });
    try {
      const page = await profiles.page(bot);
      const origin = `http://127.0.0.1:${site.port}`;
      await page.goto(`${origin}/set-cookie`);
      await page.goto(`${origin}/redirect`);
      await page.goto(`${origin}/`);
      await page.waitForFunction(
        () => {
          const results = (window as unknown as { results?: object }).results;
          return results && Object.keys(results).length === 5;
        },
        undefined,
        { timeout: 15_000 },
      );
      const results = await page.evaluate(
        () =>
          (window as unknown as { results: Record<string, unknown> }).results,
      );
      expect(results.crossOrigin).toBe("cross-origin");
      expect(results.worker).toBe("done");
      expect(String(results.refused)).toContain("failed");
      // The service worker answered, with a request of its own.
      expect(results.serviceWorker).toBe("/from-service-worker");
      expect(results.frame).toBe("done");

      for (const path of [
        "/set-cookie",
        "/redirect",
        "/landing",
        "/",
        "/cors",
        "/worker.js",
        "/from-worker",
        "/sw.js",
        "/from-service-worker",
        "/frame",
        "/from-frame",
      ]) {
        const request = seen.find((entry) => entry.path === path);
        expect({ path, verified: request?.verified }).toEqual({
          path,
          verified: AGENT,
        });
      }
      // Cookies still go out with the signature.
      expect(seen.find((entry) => entry.path === "/landing")?.cookie).toBe(
        "session=kept",
      );
      // A simple cross-origin GET stayed simple: no preflight was added for the new headers.
      expect(seen.some((entry) => entry.method === "OPTIONS")).toBe(false);
      // The filter refused the request the policy does not allow, signed or not.
      expect(refusedReached).toBe(0);
      // Whichever mode this ran in, the browser does not call itself headless, on any request.
      for (const entry of seen) {
        expect(entry.userAgent).not.toContain("HeadlessChrome");
        expect(entry.clientHints ?? "").not.toContain("HeadlessChrome");
      }
      expect(await page.evaluate(() => navigator.userAgent)).not.toContain(
        "HeadlessChrome",
      );

      // Switched off by a push that carries no key: the next request goes out unsigned.
      await setWebBotAuth(null);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await page.goto(`${origin}/after-off`);
      const after = seen.find((entry) => entry.path === "/after-off");
      expect(after?.verified).toBeNull();
    } finally {
      await setWebBotAuth(null);
      await profiles.stop(bot).catch(() => undefined);
      await stopEgressFilter();
      setEgressResolver(null);
      site.stop(true);
      crossOrigin.stop(true);
      refused.stop(true);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});
