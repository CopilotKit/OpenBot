import { describe, expect, test } from "bun:test";
import { browserRuntimeFromEnv } from "../src/browser-runtime";

describe("the configured browser runtime", () => {
  // Linux is where hosted computers run: a container, a pod, the desktop app's Podman machine.
  test("managed Linux is headed on its own virtual display", () => {
    expect(browserRuntimeFromEnv({}, "linux")).toEqual({
      backend: "managed",
      channel: "chromium",
      mode: "headed",
      useVirtualDisplay: true,
      allowExec: true,
    });
  });

  test.each(["darwin", "win32"])(
    "managed %s, a developer's own machine, stays headless",
    (platform) => {
      expect(browserRuntimeFromEnv({}, platform)).toEqual({
        backend: "managed",
        channel: "chromium",
        mode: "headless",
        useVirtualDisplay: false,
        allowExec: true,
      });
    },
  );

  test.each(["linux", "darwin", "win32"])(
    "headless is still chosen on %s when asked for",
    (platform) => {
      expect(
        browserRuntimeFromEnv({ COMPUTER_BROWSER_MODE: "headless" }, platform),
      ).toMatchObject({ mode: "headless", useVirtualDisplay: false });
    },
  );

  test.each(["linux", "darwin", "win32"])(
    "headed %s needs Xvfb only on Linux",
    (platform) => {
      expect(
        browserRuntimeFromEnv({ COMPUTER_BROWSER_MODE: "headed" }, platform)
          .useVirtualDisplay,
      ).toBe(platform === "linux");
    },
  );

  test.each(["linux", "darwin", "win32"])(
    "local Chrome on %s is headed and confined",
    (platform) => {
      expect(
        browserRuntimeFromEnv(
          { COMPUTER_BROWSER_BACKEND: "local-chrome" },
          platform,
        ),
      ).toEqual({
        backend: "local-chrome",
        channel: "chrome",
        mode: "headed",
        useVirtualDisplay: platform === "linux",
        hostname: "127.0.0.1",
        allowExec: false,
      });
    },
  );

  test("rejects unknown backends and incompatible local modes", () => {
    expect(() =>
      browserRuntimeFromEnv({ COMPUTER_BROWSER_BACKEND: "cdp" }),
    ).toThrow("COMPUTER_BROWSER_BACKEND");
    expect(() =>
      browserRuntimeFromEnv({ COMPUTER_BROWSER_MODE: "visible" }),
    ).toThrow("COMPUTER_BROWSER_MODE");
    expect(() =>
      browserRuntimeFromEnv({
        COMPUTER_BROWSER_BACKEND: "local-chrome",
        COMPUTER_BROWSER_MODE: "headless",
      }),
    ).toThrow("headed");
  });
});
