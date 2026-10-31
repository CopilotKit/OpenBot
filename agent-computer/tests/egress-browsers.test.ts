import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState } from "../../shared/openbot-browser";
import type { BrowserRuntime } from "../src/browser-runtime";
import {
  setEgressPolicy,
  setEgressResolver,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";
import type { Profiles } from "../src/profiles";

/**
 * Several browsers on one computer behind the egress filter, each judged by its own policy.
 *
 * The filter knew a browser's connections only by the credentials in them, and a browser sends a
 * proxy its credentials only when the proxy asks, which this one never did. So every browser's
 * connections arrived anonymous and were judged by every policy on the computer, strictest first:
 * with a person's browser open, a Bot allowed to reach an internal service was refused, and two Bots
 * on one computer refused each other the same way. Here a Bot allowed everything, a Bot allowed
 * nothing and a person's hosted browser allowed only its OpenBot are all open at once, in real
 * Chromium, through the real filter, and each reaches exactly what its own policy allows.
 *
 * The person's browser comes first and its Recorder's worker reports to OpenBot as it connects,
 * before any page has loaded: the worker's own requests have to answer the filter's question too.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/egress-browsers.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

const FIXTURE = join(import.meta.dir, "fixtures", "recorder");
const PERSON = "person-0123456789abcdef0123456789abcdef";
const ALLOWED_BOT = "bot-allowed-everything";
const STRICT_BOT = "bot-allowed-nothing";

const RUNTIME: BrowserRuntime = {
  backend: "managed",
  channel: "chromium",
  mode: "headless",
  useVirtualDisplay: false,
  allowExec: true,
};

const reports: { method: string }[] = [];

/** The OpenBot the person's browser may reach, which the fixture Recorder reports its calls to. */
const openbot = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/fixture/calls") {
          reports.push((await request.json()) as { method: string });
          return new Response("");
        }
        return new Response("<!doctype html><title>OpenBot</title>OpenBot", {
          headers: { "content-type": "text/html" },
        });
      },
    })
  : undefined;

/** An internal service, which only the Bot allowed everything may reach. */
const internal = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return undefined;
        return new Response(
          "<!doctype html><title>internal</title>the internal service",
          { headers: { "content-type": "text/html" } },
        );
      },
      websocket: {
        message(socket, message) {
          socket.send(`echo ${String(message)}`);
        },
      },
    })
  : undefined;

describe.skipIf(!asked)("browsers sharing a computer's egress filter", () => {
  let root = "";
  let profiles: Profiles;
  let routes: ReturnType<typeof Bun.serve>;
  const OPENBOT = `http://127.0.0.1:${openbot?.port ?? 0}`;
  const INTERNAL = `http://127.0.0.1:${internal?.port ?? 0}/`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-egress-browsers-"));
    await startEgressFilter({ env: {} });
    /*
     * Every name the filter is asked for answers 127.0.0.1, where nothing listens on a web port. A
     * browser allowed everything really does go out, and Chromium asked www.google.com for something
     * of its own, which a test must not reach: the pages here are all at 127.0.0.1 by address.
     */
    setEgressResolver(async () => ["127.0.0.1"]);
    setEgressPolicy(ALLOWED_BOT, { mode: "allow_all", rules: [] });
    setEgressPolicy(STRICT_BOT, { mode: "allowlist_only", rules: [] });
    setEgressPolicy(PERSON, {
      mode: "allowlist_only",
      rules: [
        { type: "cidr", value: "127.0.0.1/32", ports: String(openbot?.port) },
      ],
    });
    // A fresh copy of the module, as the other real-browser tests load it.
    const copy = "egress-browsers";
    const { createProfiles } = (await import(
      `../src/profiles?${copy}`
    )) as typeof import("../src/profiles");
    const { createBrowserHost } = await import("../src/browser-host");
    profiles = createProfiles(root, () => undefined, { runtime: RUNTIME });
    const host = createBrowserHost({
      profiles,
      recorderDir: () => FIXTURE,
      navigationTimeoutMs: 15_000,
    });
    routes = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        host.handle(
          request,
          new URL(request.url).pathname,
          request.headers.get("x-openbot-bot-id") ?? "",
        ),
    });
  }, 30_000);

  afterAll(async () => {
    routes?.stop(true);
    await profiles?.closeAll();
    setEgressResolver(null);
    await stopEgressFilter();
    openbot?.stop(true);
    internal?.stop(true);
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  const person = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${routes.port}${path}`, {
      method: "POST",
      headers: { "x-openbot-bot-id": PERSON },
      body: JSON.stringify(body),
    });

  /** What a page shows: the site's own text, or the filter's refusal. */
  const shown = async (botId: string, url: string): Promise<string> => {
    const page = await profiles.page(botId);
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
    return page.evaluate(() => document.body?.innerText ?? "");
  };

  test("the person's browser opens and its Recorder reaches OpenBot before any page has loaded", async () => {
    const opening = await person("/browser/open", {
      connection: {
        openbotUrl: OPENBOT,
        token: "obr_fixture-token",
        connectionId: "connection-1",
        user: { id: "user-1", name: "Pat Example", email: "pat@example.com" },
      },
    });
    expect(opening.status).toBe(200);
    expect(((await opening.json()) as BrowserState).recorder?.connected).toBe(
      true,
    );
    // The Recorder's worker told OpenBot about the connect, through the filter.
    expect(reports.map((report) => report.method)).toContain("connect");
  }, 60_000);

  test("a Bot allowed everything reaches the internal service while the person's browser is open", async () => {
    expect(profiles.isLive(PERSON)).toBe(true);
    expect(await shown(ALLOWED_BOT, INTERNAL)).toContain(
      "the internal service",
    );
    // And keeps a WebSocket to it, which the browser opens on credentials it already holds.
    const page = await profiles.page(ALLOWED_BOT);
    const echoed = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () => socket.send("hello");
          socket.onmessage = (event) => resolve(String(event.data));
          socket.onerror = () => resolve("the WebSocket failed");
        }),
      INTERNAL.replace("http:", "ws:"),
    );
    expect(echoed).toBe("echo hello");
  }, 60_000);

  test("neither the person's browser nor another Bot borrows that Bot's allowance", async () => {
    const opened = await person("/browser/navigate", { url: INTERNAL });
    // Plain HTTP: the browser shows the filter's refusal, worded for a person.
    expect(opened.status).toBe(200);
    const page = await profiles.page(PERSON);
    expect(await page.evaluate(() => document.body.innerText)).toContain(
      `This browser may not open 127.0.0.1:${internal?.port}.`,
    );
    expect(await shown(STRICT_BOT, INTERNAL)).toContain(
      `127.0.0.1:${internal?.port} is not on this deployment's network allowlist.`,
    );
  }, 60_000);

  test("and no Bot borrows the person's allowance for their OpenBot", async () => {
    expect(await shown(STRICT_BOT, OPENBOT)).toContain(
      "is not on this deployment's network allowlist.",
    );
    const opened = await person("/browser/navigate", { url: OPENBOT });
    expect(opened.status).toBe(200);
    const page = await profiles.page(PERSON);
    expect(await page.evaluate(() => document.body.innerText)).toContain(
      "OpenBot",
    );
  }, 60_000);
});
