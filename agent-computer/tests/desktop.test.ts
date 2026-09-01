import { describe, expect, test } from "bun:test";
import {
  desktopCapability,
  desktopMode,
  desktopUpstream,
} from "../src/desktop";

describe("the full computer desktop", () => {
  test("is unavailable unless both the image and its display opted in", () => {
    expect(desktopCapability({})).toEqual({
      available: false,
      protocol: "rfb",
      width: 1280,
      height: 800,
    });
    expect(
      desktopCapability({ COMPUTER_DESKTOP: "on", DISPLAY: ":99" }),
    ).toMatchObject({ available: true });
    expect(desktopCapability({ COMPUTER_DESKTOP: "on" })).toMatchObject({
      available: false,
    });
  });

  test("reports a configured framebuffer size and rejects invalid dimensions", () => {
    expect(
      desktopCapability({
        COMPUTER_DESKTOP: "on",
        DISPLAY: ":2",
        DESKTOP_WIDTH: "1440",
        DESKTOP_HEIGHT: "900",
      }),
    ).toMatchObject({ width: 1440, height: 900 });
    expect(
      desktopCapability({ DESKTOP_WIDTH: "0", DESKTOP_HEIGHT: "nonsense" }),
    ).toMatchObject({ width: 1280, height: 800 });
  });

  test("unknown modes fail closed to the read-only desktop", () => {
    expect(desktopMode("control")).toBe("control");
    for (const value of [null, "", "write", "CONTROL"]) {
      expect(desktopMode(value)).toBe("view");
    }
  });

  test("the read-only and control leases reach separate loopback bridges", () => {
    expect(desktopUpstream("view", {})).toBe("ws://127.0.0.1:6080");
    expect(desktopUpstream("control", {})).toBe("ws://127.0.0.1:6081");
    expect(
      desktopUpstream("view", { DESKTOP_VIEW_URL: "ws://viewer:7000" }),
    ).toBe("ws://viewer:7000");
    expect(
      desktopUpstream("control", {
        DESKTOP_CONTROL_URL: "ws://driver:7001",
      }),
    ).toBe("ws://driver:7001");
  });
});
