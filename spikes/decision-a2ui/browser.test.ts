import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { demoServer } from "./demo.ts";

for (const mode of ["decision", "express"]) {
  test(`unchanged Lit renderer: ${mode} fixture, controls and follow-up`, async () => {
    const server = await demoServer();
    const browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: "chrome" },
    );
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.url);
      await page.getByLabel("Fixture path").selectOption(mode);

      async function show(family: string) {
        await page.getByLabel("Screen").selectOption(family);
        await page.getByRole("button", { name: "Render fixture" }).click();
      }
      await show("settings");
      const name = page.locator("a2ui-surface").getByRole("textbox");
      await name.waitFor();
      assert.equal(await name.inputValue(), "Ada");
      assert.equal(
        await page.locator("a2ui-surface").getByRole("checkbox").isChecked(),
        true,
      );

      await show("results");
      const surface = page.locator("a2ui-surface");
      await surface.getByText("Select a result to see its details.").waitFor();
      await surface.getByRole("button", { name: "Birch" }).click();
      await surface.getByText("Birch — available").waitFor();
      assert.equal(
        await page.getByRole("status").textContent(),
        "Action applied",
      );

      await show("confirmation");
      await surface.getByText("Reserve one place in Birch.").waitFor();
      const confirm = surface.getByRole("button", { name: "Confirm" });
      await confirm.waitFor();
      if (mode === "decision") {
        await confirm.click();
        await surface.getByText("Confirmed.").waitFor();
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  });
}
