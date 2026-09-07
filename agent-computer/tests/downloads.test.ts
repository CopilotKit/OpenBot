import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

/**
 * A real Chromium download, asked for by name because the ordinary suite does not require a browser:
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test agent-computer/tests/downloads.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

const pdf = "%PDF-1.4\nOpenBot download test\n%%EOF\n";
const secondPdf = "%PDF-1.4\nOpenBot second download test\n%%EOF\n";
const site = Bun.serve({
  port: 0,
  fetch(request) {
    return new Response(
      new URL(request.url).searchParams.has("second") ? secondPdf : pdf,
      {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="invoice-001.pdf"',
        },
      },
    );
  },
});

afterAll(() => site.stop(true));

describe.skipIf(!asked)("browser downloads kept in the Bot workspace", () => {
  test("keeps Stripe's suggested PDF name after Chromium closes", async () => {
    const { persistDownload } = await import("../src/downloads");
    const { chromium } = await import("playwright");
    const root = await mkdtemp(join(tmpdir(), "openbot-downloads-"));
    const context = await chromium.launch({ headless: true });

    try {
      const page = await context.newPage();
      await page.setContent(
        `<a id="invoice" href="http://127.0.0.1:${site.port}/invoice">Download invoice</a>`,
      );
      const waiting = page.waitForEvent("download");
      await page.click("#invoice");
      const saved = await persistDownload(await waiting, root);

      expect(saved).toBe(join(root, "invoice-001.pdf"));
      expect(await readFile(saved, "utf8")).toBe(pdf);

      await page.setContent(
        `<a id="invoice" href="http://127.0.0.1:${site.port}/invoice?second">Download invoice again</a>`,
      );
      const waitingAgain = page.waitForEvent("download");
      await page.click("#invoice");
      const savedAgain = await persistDownload(await waitingAgain, root);

      expect(savedAgain).toBe(join(root, "invoice-001 (2).pdf"));
      expect(await readFile(saved, "utf8")).toBe(pdf);
      expect(await readFile(savedAgain, "utf8")).toBe(secondPdf);

      await context.close();
      expect(await readFile(saved, "utf8")).toBe(pdf);
      expect(await readFile(savedAgain, "utf8")).toBe(secondPdf);
    } finally {
      await context.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
