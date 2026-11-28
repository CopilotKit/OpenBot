import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright-core";
import { ensureServer, HOOK_START_MS, HOOK_STOP_MS } from "./server";
const asked = process.env.OPENBOT_APP_BROWSER === "1";
let browser: Browser | undefined;
let server: Awaited<ReturnType<typeof ensureServer>> | undefined;
beforeAll(async () => {
  if (!asked) return;
  server = await ensureServer();
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ channel: "chromium" });
}, HOOK_START_MS);
afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, HOOK_STOP_MS);

test.skipIf(!asked)(
  "real navigation, config links, comments and live macOS warnings",
  async () => {
    if (!browser || !server) throw new Error("No browser or server.");
    const page = await browser.newPage({
      viewport: { width: 1800, height: 1200 },
      reducedMotion: "reduce",
    });
    try {
      await page.goto(`${server.url}/workbench/`);
      await page.waitForFunction(() => window.__workbenchPage?.ready);
      expect(await page.evaluate(() => window.__workbenchPage?.scene)).toBe(
        "app-home",
      );
      const iframe = page.locator("[data-workbench-window] iframe");
      const app = await (await iframe.elementHandle())?.contentFrame();
      if (!app) throw new Error("No app frame.");
      await app.locator("#root > *").first().waitFor();
      await page
        .getByRole("textbox", { name: "App route" })
        .fill("/connections");
      await page.getByRole("button", { name: "Go", exact: true }).click();
      await page.waitForFunction(
        () => window.__workbenchPage?.route() === "/connections",
      );
      const config = await page.evaluate(() =>
        window.__workbenchPage?.config(),
      );
      expect(config?.route).toBe("/connections");
      await page.getByRole("textbox", { name: "App route" }).fill("/settings");
      await page.getByRole("textbox", { name: "App route" }).press("c");
      expect(
        await page
          .getByRole("button", { name: "Comment", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("false");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const target = await app
        .locator("h1, h2, button")
        .filter({ visible: true })
        .first()
        .boundingBox();
      if (!target) throw new Error("No visible app element.");
      await page.mouse.click(
        target.x + target.width / 2,
        target.y + target.height / 2,
      );
      await page
        .getByRole("textbox", {
          name: "What do you want to change?",
          exact: true,
        })
        .waitFor();
      await page.keyboard.press("Escape");
      // A source edit or an interactive change is observed without advancing any clock.
      await app.evaluate(() => {
        const el = document.createElement("button");
        el.id = "wb-overlap";
        el.textContent = "Overlap fixture";
        Object.assign(el.style, {
          position: "fixed",
          left: "21px",
          top: "26px",
          width: "40px",
          height: "24px",
          zIndex: "99999",
        });
        document.body.append(el);
      });
      await page.waitForFunction(() =>
        window.__workbenchPage
          ?.warnings()
          .some(
            (w) => w.kind === "spacing" && w.label.includes("Overlap fixture"),
          ),
      );
      const issue = page
        .getByRole("list", { name: "Layout warnings" })
        .getByRole("button")
        .filter({ hasText: "Overlap fixture" })
        .first();
      await issue.click();
      await page.locator(".wb-highlight").waitFor();
      await app.evaluate(() => document.getElementById("wb-overlap")?.remove());
      await page.waitForFunction(
        () =>
          !window.__workbenchPage
            ?.warnings()
            .some((w) => w.label.includes("Overlap fixture")),
      );
      const query = new URL(await page.url()).search;
      await page.goto(`${server.url}/workbench/${query}`);
      await page.waitForFunction(
        () =>
          window.__workbenchPage?.ready &&
          window.__workbenchPage.route() === "/connections",
      );
      expect(
        await page.evaluate(() => window.__workbenchPage?.errors()),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  },
  60_000,
);
