import { describe, expect, test } from "bun:test";
import {
  computerSocketIsolationRefusal,
  computerSocketUrl,
  parseComputerSocketPath,
  parseComputerSocketLease,
} from "../src/computer/socket-proxy";

const LEASE = "a".repeat(86);

describe("the computer WebSocket proxy", () => {
  test("accepts only the page stream and full desktop routes", () => {
    expect(parseComputerSocketPath("/api/computers/sales-bot/stream")).toEqual({
      botId: "sales-bot",
      kind: "stream",
    });
    expect(parseComputerSocketPath("/api/computers/a%20b/desktop")).toEqual({
      botId: "a b",
      kind: "desktop",
    });
    for (const path of [
      "/api/computers/a/shell",
      "/api/computers/a/desktop/more",
      "/api/computers/%E0%A4%A/desktop",
    ]) {
      expect(parseComputerSocketPath(path)).toBeNull();
    }
  });

  test("offers a process-wide desktop only when the provider isolates the whole computer", () => {
    expect(
      computerSocketIsolationRefusal("desktop", "per-bot"),
    ).toBeUndefined();
    expect(computerSocketIsolationRefusal("desktop", "shared")).toBe(
      "A full desktop requires one isolated computer per Bot.",
    );
    expect(computerSocketIsolationRefusal("desktop", undefined)).toBe(
      "A full desktop requires one isolated computer per Bot.",
    );
    expect(computerSocketIsolationRefusal("stream", "shared")).toBeUndefined();
  });

  test("keeps the token on the internal URL and defaults desktop access to view-only", () => {
    const url = new URL(
      computerSocketUrl({
        baseUrl: "https://computer.internal/",
        botId: "sales bot",
        kind: "desktop",
        token: "not-for-the-browser",
        mode: "anything-else",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/desktop");
    expect(url.searchParams.get("bot")).toBe("sales bot");
    expect(url.searchParams.get("token")).toBe("not-for-the-browser");
    expect(url.searchParams.get("mode")).toBe("view");
  });

  test("names control only when explicitly requested and leaves it off page streams", () => {
    const desktop = computerSocketUrl({
      baseUrl: "http://127.0.0.1:4100",
      botId: "one",
      kind: "desktop",
      token: "secret",
      mode: "control",
      lease: LEASE,
    });
    expect(new URL(desktop).searchParams.get("mode")).toBe("control");
    expect(new URL(desktop).searchParams.get("lease")).toBe(LEASE);

    const stream = computerSocketUrl({
      baseUrl: "http://127.0.0.1:4100",
      botId: "one",
      kind: "stream",
      token: "secret",
      mode: "control",
      lease: LEASE,
    });
    expect(new URL(stream).searchParams.has("mode")).toBe(false);
    expect(new URL(stream).searchParams.get("lease")).toBe(LEASE);
  });

  test("accepts only a well-formed control capability from WebSocket protocols", () => {
    expect(parseComputerSocketLease(`binary, openbot-lease.${LEASE}`)).toBe(
      LEASE,
    );
    expect(
      parseComputerSocketLease("binary, openbot-lease.short"),
    ).toBeUndefined();
    expect(parseComputerSocketLease("binary")).toBeUndefined();
  });
});
