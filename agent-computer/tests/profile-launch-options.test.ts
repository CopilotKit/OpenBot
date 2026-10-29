import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYWRIGHT_DISABLED_FEATURES } from "../src/person-launch";

const original = { ...process.env };
afterEach(() => {
  for (const name of [
    "COMPUTER_BROWSER_BACKEND",
    "COMPUTER_BROWSER_MODE",
    "COMPUTER_SANDBOX",
    "OPENBOT_RECORDER_DIR",
  ]) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

// The root CI install deliberately excludes this separately deployed package's dependencies.
describe.skipIf(
  !existsSync(join(import.meta.dir, "../node_modules/playwright/package.json")),
)("persistent launch options", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "recorder");
  test.each([
    ["managed", false],
    ["managed", true],
    ["local-chrome", true],
  ] as const)(
    "%s passes the runtime to the persistent launcher (a built Recorder here: %p)",
    async (backend, recorder) => {
      const { chromium } = await import("playwright");
      process.env.COMPUTER_BROWSER_BACKEND = backend;
      delete process.env.COMPUTER_BROWSER_MODE;
      delete process.env.COMPUTER_SANDBOX;
      if (recorder) process.env.OPENBOT_RECORDER_DIR = FIXTURE;
      else delete process.env.OPENBOT_RECORDER_DIR;
      // Let in only where Bots run in the computer's own Chromium: local Chrome is a window on the person's desktop.
      const withRecorder = recorder && backend === "managed";
      const launch = spyOn(
        chromium,
        "launchPersistentContext",
      ).mockImplementation(async () => {
        throw new Error("launch inspected without starting a browser");
      });
      const { createProfiles } = await import(
        `../src/profiles?launch-options=${backend}-${recorder}`
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
        // Managed is headed where hosted computers run (Linux) and headless on a developer's machine.
        expect(options?.headless).toBe(
          backend === "managed" && process.platform !== "linux",
        );
        expect(options?.handleSIGINT).toBe(false);
        expect(options?.handleSIGTERM).toBe(false);
        if (backend === "local-chrome") {
          expect(options?.chromiumSandbox).toBe(true);
          expect(options?.args).not.toContain("--password-store=basic");
          expect(options?.args).not.toContain("--no-sandbox");
        }
        /*
         * The whole launch, pinned. A Bot's browser keeps exactly these options, with every Playwright default
         * it had before. A built Recorder on this computer lets in the Recorder and nothing else, as the hosted
         * person's browser lets it in: its four switches after the Bot's own, and Playwright's
         * `--disable-extensions` dropped, without which no extension loads (`shared/bot-browser.ts`). Its
         * features are Playwright's own and AcceptCHFrame, off for every browser behind the egress filter, or
         * Google never loads in it (profiles.ts).
         */
        const features = `--disable-features=${[
          ...PLAYWRIGHT_DISABLED_FEATURES,
          "AcceptCHFrame",
        ].join(",")}`;
        expect(options).toEqual({
          channel: backend === "managed" ? "chromium" : "chrome",
          headless: backend === "managed" && process.platform !== "linux",
          args:
            backend === "managed"
              ? [
                  "--no-sandbox",
                  "--disable-dev-shm-usage",
                  "--password-store=basic",
                  "--disable-blink-features=AutomationControlled",
                  features,
                  ...(withRecorder
                    ? [
                        `--disable-extensions-except=${FIXTURE}`,
                        `--load-extension=${FIXTURE}`,
                        "--enable-unsafe-extension-debugging",
                        "--silent-debugger-extension-api",
                      ]
                    : []),
                ]
              : [
                  "--disable-dev-shm-usage",
                  "--disable-blink-features=AutomationControlled",
                  features,
                ],
          ignoreDefaultArgs: withRecorder
            ? ["--enable-automation", "--disable-extensions"]
            : ["--enable-automation"],
          chromiumSandbox: backend === "local-chrome",
          viewport: { width: 1280, height: 800 },
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
        });
      } finally {
        await profiles.closeAll();
        launch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("a hosted person's browser is headed or headless exactly as a Bot's is beside it", async () => {
    // Headless on a developer's machine and headed on the virtual display where hosted computers
    // run (Linux), for the person as for the Bot: a headless browser names itself HeadlessChrome,
    // which is what the person's must never be where a Bot's is not.
    const { chromium } = await import("playwright");
    process.env.COMPUTER_BROWSER_BACKEND = "managed";
    delete process.env.COMPUTER_BROWSER_MODE;
    delete process.env.COMPUTER_SANDBOX;
    const launch = spyOn(
      chromium,
      "launchPersistentContext",
    ).mockImplementation(async () => {
      throw new Error("launch inspected without starting a browser");
    });
    const copy = "person";
    const { createProfiles } = await import(
      `../src/profiles?launch-options=${copy}`
    );
    const { findRecorder } = await import("../src/recorder");
    const found = await findRecorder(
      join(import.meta.dir, "fixtures", "recorder"),
    );
    if (!found.ok) throw new Error(found.error);
    const root = await mkdtemp(join(tmpdir(), "openbot-launch-options-"));
    const profiles = createProfiles(root);
    try {
      await expect(profiles.page("bot-one")).rejects.toThrow(
        "launch inspected",
      );
      await expect(
        profiles.page("person-0123456789abcdef0123456789abcdef", {
          open: { recorder: found.recorder },
        }),
      ).rejects.toThrow("launch inspected");
      const [[, bot], [, person]] = launch.mock.calls as [
        unknown,
        { headless?: boolean; channel?: string; args?: string[] },
      ][];
      expect(person?.headless).toBe(bot?.headless);
      expect(person?.headless).toBe(process.platform !== "linux");
      expect(person?.channel).toBe(bot?.channel);
      // Every switch a Bot's browser launches with, and then the Recorder's own.
      expect(person?.args?.slice(0, bot?.args?.length)).toEqual(bot?.args);
    } finally {
      await profiles.closeAll();
      launch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
