import { describe, expect, test } from "bun:test";
import { browserModeFromEnv } from "../src/browser-mode";

describe("choosing the browser people take over", () => {
  test("keeps the existing headless browser when no mode is configured", () => {
    expect(browserModeFromEnv(undefined)).toBe("headless");
    expect(browserModeFromEnv("")).toBe("headless");
  });

  test("runs the full browser only when headed is requested", () => {
    expect(browserModeFromEnv("headed")).toBe("headed");
    expect(browserModeFromEnv("headless")).toBe("headless");
  });

  test("refuses a typo rather than silently changing browser behavior", () => {
    expect(() => browserModeFromEnv("visible")).toThrow(
      'COMPUTER_BROWSER_MODE must be headless or headed, not "visible".',
    );
  });
});
