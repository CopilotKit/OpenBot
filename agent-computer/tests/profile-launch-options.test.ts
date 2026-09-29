import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const original = { ...process.env };
afterEach(() => {
  for (const name of [
    "COMPUTER_BROWSER_BACKEND",
    "COMPUTER_BROWSER_MODE",
    "COMPUTER_SANDBOX",
  ]) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

// The root CI install deliberately excludes this separately deployed package's dependencies.
describe.skipIf(
  !existsSync(join(import.meta.dir, "../node_modules/playwright/package.json")),
)("persistent launch options", () => {
  test.each(["managed", "local-chrome"])(
    "%s passes the runtime to the persistent launcher",
    async (backend) => {
      const { chromium } = await import("playwright");
      process.env.COMPUTER_BROWSER_BACKEND = backend;
      delete process.env.COMPUTER_BROWSER_MODE;
      delete process.env.COMPUTER_SANDBOX;
      const launch = spyOn(
        chromium,
        "launchPersistentContext",
      ).mockImplementation(async () => {
        throw new Error("launch inspected without starting a browser");
      });
      const { createProfiles } = await import(
        `../src/profiles?launch-options=${backend}`
      );
      const root = await mkdtemp(join(tmpdir(), "openbot-launch-options-"));
      const profiles = createProfiles(root);
      try {
        await expect(profiles.page("bot-one")).rejects.toThrow(
          "launch inspected",
        );
        expect(launch).toHaveBeenCalledTimes(1);
        const [directory, options] = launch.mock.calls[0]!;
        expect(directory).toBe(join(root, "bot-one"));
        expect(options?.channel).toBe(
          backend === "managed" ? "chromium" : "chrome",
        );
        expect(options?.headless).toBe(backend === "managed");
        expect(options?.handleSIGINT).toBe(false);
        expect(options?.handleSIGTERM).toBe(false);
        expect(options?.ignoreDefaultArgs).toEqual(["--enable-automation"]);
        if (backend === "local-chrome") {
          expect(options?.chromiumSandbox).toBe(true);
          expect(options?.args).not.toContain("--password-store=basic");
          expect(options?.args).not.toContain("--no-sandbox");
        }
      } finally {
        await profiles.closeAll();
        launch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
