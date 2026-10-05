import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { Cookie } from "playwright";
import {
  cookiesToRestore,
  isSessionCookie,
  SESSION_COOKIES_FILE,
  serialiseSessionCookies,
} from "../src/session-cookies";

/**
 * A Bot's session cookies surviving the pod going away.
 *
 * The rules run everywhere. The browser half is asked for by name, like follows-popup.test.ts,
 * because it launches a real Chromium the machine running `bun test` is not required to have:
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/session-cookies.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const LAUNCH_TIMEOUT_MS = 120_000;

const cookie = (overrides: Partial<Cookie>): Cookie => ({
  name: "sid",
  value: "v",
  domain: "example.test",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
  ...overrides,
});

describe("which cookies are kept", () => {
  test("only session cookies are written, in a stable order", () => {
    const body = serialiseSessionCookies([
      cookie({ name: "b" }),
      cookie({ name: "remember", expires: 4_000_000_000 }),
      cookie({ name: "a" }),
    ]);
    const saved = JSON.parse(body).cookies as Cookie[];
    expect(saved.map((c) => c.name)).toEqual(["a", "b"]);
    expect(saved.every(isSessionCookie)).toBeTrue();
    // Same set, other order: the same bytes, so an unchanged browser writes nothing.
    expect(
      serialiseSessionCookies([cookie({ name: "a" }), cookie({ name: "b" })]),
    ).toBe(body);
  });

  test("restores what the browser lacks and skips what it holds or what has expired", () => {
    const now = 1_000;
    const restored = cookiesToRestore(
      [
        cookie({ name: "sid" }),
        cookie({ name: "held" }),
        cookie({ name: "stale", expires: 999 }),
        cookie({ name: "fresh", expires: 2_000 }),
      ],
      [cookie({ name: "held", value: "from-the-profile" })],
      now,
    );
    expect(restored.map((c) => c.name)).toEqual(["sid", "fresh"]);
  });
});

const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    const headers = new Headers({ "content-type": "text/plain" });
    if (pathname === "/set") {
      // The shape httpbin's /cookies/set gives: no Max-Age, no Expires. A session cookie.
      headers.append("set-cookie", "session_sid=abc123; Path=/; HttpOnly");
      headers.append(
        "set-cookie",
        "remember=yes; Path=/; Max-Age=86400; HttpOnly",
      );
      return new Response("set", { headers });
    }
    return new Response(request.headers.get("cookie") ?? "", { headers });
  },
});
const origin = `http://127.0.0.1:${site.port}`;

afterAll(() => {
  site.stop(true);
});

describe.skipIf(!asked)("a session cookie across a restart", () => {
  test(
    "comes back after the browser is stopped and started again, and after shutdown",
    async () => {
      const { createProfiles } = await import("../src/profiles");
      const root = await mkdtemp(join(tmpdir(), "openbot-profiles-"));
      const bot = "session-cookie-test";
      const sent = async (profiles: ReturnType<typeof createProfiles>) => {
        const page = await profiles.page(bot);
        await page.goto(`${origin}/echo`);
        return (await page.textContent("body")) ?? "";
      };

      try {
        const first = createProfiles(root, () => undefined);
        const page = await first.page(bot);
        await page.goto(`${origin}/set`);
        expect(await sent(first)).toContain("session_sid=abc123");

        // The stop and idle path.
        await first.stop(bot);
        const file = join(root, bot, SESSION_COOKIES_FILE);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        const saved = await readFile(file, "utf8");
        expect(saved).toContain("session_sid");
        // Only the session cookie: the persistent one is the profile's to keep.
        expect(saved).not.toContain("remember");

        const afterStop = await sent(first);
        expect(afterStop).toContain("session_sid=abc123");
        // Exactly once, not restored on top of itself.
        expect(afterStop.match(/session_sid=/g)?.length).toBe(1);
        expect(afterStop).toContain("remember=yes");

        // The SIGTERM path: a new process on the same profile, as a pod after a suspend is.
        await first.closeAll();
        const second = createProfiles(root, () => undefined);
        try {
          const afterRestart = await sent(second);
          expect(afterRestart).toContain("session_sid=abc123");
          expect(afterRestart).toContain("remember=yes");

          // Reset forgets it with the rest of the profile.
          await second.reset(bot);
          const afterReset = await sent(second);
          expect(afterReset).not.toContain("session_sid");
          expect(afterReset).not.toContain("remember");
        } finally {
          await second.closeAll();
        }
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    LAUNCH_TIMEOUT_MS,
  );

  test(
    "a Bot never receives another Bot's session cookie",
    async () => {
      const { createProfiles } = await import("../src/profiles");
      const root = await mkdtemp(join(tmpdir(), "openbot-profiles-"));
      const profiles = createProfiles(root, () => undefined);
      try {
        const one = await profiles.page("bot-one");
        await one.goto(`${origin}/set`);
        await profiles.stop("bot-one");
        const other = await profiles.page("bot-two");
        await other.goto(`${origin}/echo`);
        expect((await other.textContent("body")) ?? "").not.toContain(
          "session_sid",
        );
      } finally {
        await profiles.closeAll();
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});
