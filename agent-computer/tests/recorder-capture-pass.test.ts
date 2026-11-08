import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
 * Record pressed in a person's hosted browser that has just started, before any page has loaded.
 *
 * The Recorder asks OpenBot for its capture pass from its offscreen document, through the computer's
 * egress filter, whose browser listener answers 407 until the browser sends its credentials.
 * Playwright answers that 407 for the pages and workers it attaches to, and never attaches to an
 * offscreen document, so the document's request goes with only what the browser itself holds for the
 * filter. A browser holds that once one request of its own has answered the filter's challenge. When
 * the computer starts again, the person's browser opens on the profile it had and its Recorder
 * still holds its connection, so nothing in the new browser has asked anything of the filter by the
 * time Record is pressed: the pass got the filter's 407, the Recorder held the recording as an
 * answer it does not know, and it never reached Intelligence.
 *
 * Real Chromium, the real filter and the computer's own routes; the fixture Recorder with an
 * offscreen document that asks for the pass as the Recorder's does (`fixtures/recorder-pass`).
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/recorder-capture-pass.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

const FIXTURE = join(import.meta.dir, "fixtures", "recorder");
const PASS = join(import.meta.dir, "fixtures", "recorder-pass");
const PERSON = "person-0123456789abcdef0123456789abcdef";

const RUNTIME: BrowserRuntime = {
  backend: "managed",
  channel: "chromium",
  mode: "headless",
  useVirtualDisplay: false,
  allowExec: true,
};

/** The capture passes OpenBot was asked for. */
const passes: string[] = [];

/** The OpenBot the person's browser may reach. */
const openbot = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        const pass = /^\/api\/copilotkit\/trajectory\/([^/]+)\/connect$/.exec(
          pathname,
        );
        if (pass?.[1]) {
          passes.push(pass[1]);
          return Response.json({
            joinToken: "join-token",
            realtime: { clientUrl: "ws://127.0.0.1:9/socket", topic: "t" },
          });
        }
        // The Recorder asking who a new connection is for: it stands.
        if (pathname === "/api/recorder/me") return Response.json({});
        return Response.json({});
      },
    })
  : undefined;

/** The fixture Recorder with the offscreen document Record asks for the capture pass from. */
async function recorderWithCapturePass(root: string): Promise<string> {
  const dir = join(root, "recorder");
  await cp(FIXTURE, dir, { recursive: true });
  await cp(join(PASS, "offscreen.html"), join(dir, "offscreen.html"));
  await cp(join(PASS, "offscreen.js"), join(dir, "offscreen.js"));
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as { permissions: string[] };
  manifest.permissions.push("offscreen");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  const worker = await readFile(join(dir, "service-worker.js"), "utf8");
  const recordPass = await readFile(join(PASS, "record-pass.js"), "utf8");
  await writeFile(join(dir, "service-worker.js"), `${worker}\n${recordPass}`);
  return dir;
}

describe.skipIf(!asked)(
  "the Recorder's capture pass from a browser that has just started",
  () => {
    let root = "";
    let profiles: Profiles;
    let routes: ReturnType<typeof Bun.serve>;
    const OPENBOT = `http://127.0.0.1:${openbot?.port ?? 0}`;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "openbot-capture-pass-"));
      await startEgressFilter({ env: {} });
      // Chromium asks names of its own (www.google.com among them), which a test must not reach.
      setEgressResolver(async () => ["127.0.0.1"]);
      // A person's hosted browser may reach its OpenBot and nothing else, as the server pushes it.
      setEgressPolicy(PERSON, {
        mode: "allowlist_only",
        rules: [
          {
            type: "cidr",
            value: "127.0.0.1/32",
            ports: String(openbot?.port),
          },
        ],
      });
      const recorderDir = await recorderWithCapturePass(root);
      const copy = "recorder-capture-pass";
      const { createProfiles } = (await import(
        `../src/profiles?${copy}`
      )) as typeof import("../src/profiles");
      const { createBrowserHost } = await import("../src/browser-host");
      profiles = createProfiles(root, () => undefined, { runtime: RUNTIME });
      const host = createBrowserHost({
        profiles,
        recorderDir: () => recorderDir,
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
      if (root) await rm(root, { recursive: true, force: true });
    }, 60_000);

    const person = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${routes.port}${path}`, {
        method: "POST",
        headers: { "x-openbot-bot-id": PERSON },
        body: JSON.stringify(body),
      });

    /** Opens the person's browser, handing the Recorder its connection only when told to. */
    const open = async (handing: boolean) => {
      const opening = await person(
        "/browser/open",
        handing
          ? {
              connection: {
                openbotUrl: OPENBOT,
                token: "obr_fixture-token",
                connectionId: "connection-1",
                user: {
                  id: "user-1",
                  name: "Pat Example",
                  email: "pat@example.com",
                },
              },
            }
          : {},
      );
      expect(opening.status).toBe(200);
      expect(((await opening.json()) as BrowserState).recorder?.connected).toBe(
        true,
      );
    };

    /** What OpenBot's answer to the offscreen document's capture pass was, as the document saw it. */
    const passStatus = async (): Promise<unknown> => {
      const browser = profiles.person(PERSON);
      const worker = browser?.context
        .serviceWorkers()
        .find((each) =>
          each.url().startsWith(`chrome-extension://${browser.recorderId}/`),
        );
      if (!worker) throw new Error("The Recorder's worker is not running.");
      // Written out, since this process has no `chrome` to type it against.
      return worker.evaluate(
        'chrome.storage.local.get("pass").then((stored) => stored.pass)',
      );
    };

    test("Record before any page has loaded, in a browser opened again on its profile, reaches OpenBot", async () => {
      // The computer's first start: the Recorder is handed its connection and asks OpenBot about it.
      await open(true);
      // The computer starts again: the browser closes, and OpenBot opens it on the same profile with
      // no connection, since the one the Recorder holds stands (browser-host.ts), so the Recorder
      // asks OpenBot nothing.
      expect((await person("/browser/close", {})).status).toBe(200);
      expect(profiles.isLive(PERSON)).toBe(false);
      await open(false);

      const started = await person("/browser/recording", {
        action: "start",
        title: "Right after the computer started",
      });
      expect(started.status).toBe(200);
      // OpenBot's own answer, not the filter's 407.
      expect(await passStatus()).toBe(200);
      expect(passes).toHaveLength(1);
      expect(
        (await person("/browser/recording", { action: "stop" })).status,
      ).toBe(200);
    }, 90_000);
  },
);
