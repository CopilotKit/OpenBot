import { describe, expect, test } from "bun:test";
import {
  HANDBACK_COMMANDS,
  PAGE_COMMANDS,
} from "../../desktop/src/fakeNative/pageRegistry";
import {
  connectedAnswers,
  NO_DEFAULT,
  PAGE_DEFAULTS,
  pageFallback,
  SCRIPTED,
} from "./pageDefaults";

const known = new Set<string>(PAGE_COMMANDS);

describe("page defaults", () => {
  test("every page command has a default, a script or a reason", () => {
    const missing = PAGE_COMMANDS.filter(
      (command) =>
        !(command in PAGE_DEFAULTS) &&
        !(command in SCRIPTED) &&
        !(command in NO_DEFAULT),
    );
    expect(missing).toEqual([]);
  });

  test("no key is outside PAGE_COMMANDS", () => {
    for (const table of [PAGE_DEFAULTS, SCRIPTED, NO_DEFAULT]) {
      for (const key of Object.keys(table)) expect(known.has(key)).toBe(true);
    }
  });

  test("the handback commands resolve with null", () => {
    for (const command of HANDBACK_COMMANDS)
      expect(PAGE_DEFAULTS[command]).toBeNull();
  });

  test("the fallback refuses an unknown command with a string", () => {
    const fallback = pageFallback();
    let refused: unknown;
    try {
      fallback("plugin:openbot-desktop|nope", undefined);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBe("command plugin:openbot-desktop|nope not found");
  });

  test("the fallback refuses a command with no default", () => {
    expect(() =>
      pageFallback()("plugin:openbot-desktop|speech_start", undefined),
    ).toThrow();
  });

  test("the fallback gives scripts first, then defaults", () => {
    const fallback = pageFallback();
    expect(
      fallback("plugin:openbot-desktop|set_usage_data", { share: false }),
    ).toEqual({ shared: false, offByEnvironment: false });
    expect(
      fallback("plugin:openbot-desktop|intelligence", { action: "status" }),
    ).toEqual({ readiness: "ready" });
    expect(
      fallback("plugin:openbot-desktop|intelligence", { action: "start" }),
    ).toEqual({ outcome: "completed" });
    expect(fallback("plugin:openbot-desktop|usage_data", undefined)).toEqual({
      shared: true,
      offByEnvironment: false,
    });
    expect(fallback("plugin:openbot-desktop|quit", undefined)).toBeNull();
  });

  test("connectedAnswers names the address", () => {
    expect(connectedAnswers("https://openbot.example.com")).toEqual({
      "plugin:openbot-desktop|connection": {
        mode: "value",
        value: { mode: "connected", address: "https://openbot.example.com" },
      },
    });
  });
});
