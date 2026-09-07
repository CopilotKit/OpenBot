import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The optional full browser, driven as the container drives it.
 *
 * Asked for explicitly because it needs a virtual display and a real Chromium:
 *
 *   xvfb-run -a env OPENBOT_HEADED_BROWSER=1 bun test tests/headed-browser.test.ts
 */
const asked = process.env.OPENBOT_HEADED_BROWSER === "1";
const TOKEN = "headed-browser-test-token";
const BOT = "headed-browser";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("The port probe did not return a TCP address."));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

let base = "";
let root = "";

function api(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": BOT,
      "x-openbot-computer-token": TOKEN,
      ...(init?.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "agent-computer-headed-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  process.env.COMPUTER_TOKEN = TOKEN;
  process.env.COMPUTER_BROWSER_MODE = "headed";
  process.env.PORT = String(port);
  process.env.PROFILES_DIR = join(root, "profiles");
  process.env.WORKSPACE_DIR = join(root, "workspace");
  await mkdir(process.env.PROFILES_DIR, { recursive: true });
  await import(`../src/index?headed=${Date.now()}`);
});

afterAll(async () => {
  if (!asked) return;
  await api("/computers/stop", { method: "POST" }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!asked)("a browser a person can take over", () => {
  test("is full Chromium rather than the headless shell", async () => {
    const page =
      "data:text/html," +
      encodeURIComponent(
        "<body></body><script>document.body.textContent=navigator.userAgent+'\\nwebdriver='+navigator.webdriver</script>",
      );
    const navigated = await api("/navigate", {
      method: "POST",
      body: JSON.stringify({ url: page }),
    });
    expect(navigated.status).toBe(200);

    const read = await api("/read");
    const body = (await read.json()) as { text?: string };
    expect(body.text).not.toContain("HeadlessChrome");
    expect(body.text).toContain("webdriver=false");
  }, 30_000);
});
