import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

/**
 * Asked for by name, like the deployment journey at the repository root: it launches a real Chromium,
 * which the machine running `bun test` is not required to have. The import is inside the test rather
 * than at the top of the file for the same reason.
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/follows-popup.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const LAUNCH_TIMEOUT_MS = 120_000;

const html = (title: string, body: string) =>
  new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const site = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/popup") return html("POPUP", "<p>the popup</p>");
    return html(
      "OPENER",
      `<button id="open" onclick="window.open('/popup','_blank','width=500,height=500')">open</button>`,
    );
  },
});
const origin = `http://127.0.0.1:${site.port}`;

afterAll(() => {
  site.stop(true);
});

/** Playwright delivers the opening and the closing as events, so the record moves a tick later. */
async function settle(read: () => Promise<string>, wanted: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await read()).includes(wanted)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!asked)("the page a Bot is on", () => {
  test(
    "follows a window the site opens, and comes back when it closes",
    async () => {
      const { createProfiles } = await import("../src/profiles");
      const root = await mkdtemp(join(tmpdir(), "openbot-profiles-"));
      const profiles = createProfiles(root);
      const bot = "popup-test";
      const url = async () => (await profiles.page(bot)).url();

      try {
        const opener = await profiles.page(bot);
        await opener.goto(`${origin}/opener`, {
          waitUntil: "domcontentloaded",
        });
        expect(await url()).toContain("/opener");

        await opener.click("#open");
        await settle(url, "/popup");
        // The defect this covers: the popup is open and rendering, and everything the Bot and the
        // person taking the wheel can reach is still pointed at the page it launched with.
        expect(await url()).toContain("/popup");

        const popup = await profiles.page(bot);
        await popup.close();
        await settle(url, "/opener");
        expect(await url()).toContain("/opener");
        // A sign-in popup closes itself when it succeeds, and the profile that just received it must
        // still be there.
        expect(opener.isClosed()).toBeFalse();
      } finally {
        await profiles.stop(bot).catch(() => undefined);
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});
