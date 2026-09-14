import { describe, expect, test } from "bun:test";
import {
  assistanceHistoryPath,
  assistanceResponseOutcome,
  assistanceToken,
  captureAssistanceToken,
} from "../src/routes/_authed/assist";

describe("Slack assistance route status mapping", () => {
  test("accepts only a non-empty opaque token", () => {
    expect(assistanceToken({ token: "  sealed  " })).toBe("sealed");
    expect(assistanceToken({ token: "" })).toBeNull();
    expect(assistanceToken({ token: 123 })).toBeNull();
  });

  test("maps only a validated agent response to a ready destination", () => {
    expect(assistanceResponseOutcome(200, { agentId: "risk analyst" })).toEqual(
      {
        kind: "ready",
        href: "/bot?agent=risk%20analyst",
      },
    );
    expect(assistanceResponseOutcome(200, { agentId: "" })).toEqual({
      kind: "error",
    });
  });

  test("keeps invalid, wrong-user, and retryable failures non-navigable", () => {
    expect(assistanceResponseOutcome(403, { agentId: "forged" })).toEqual({
      kind: "wrong-user",
    });
    expect(assistanceResponseOutcome(410, { agentId: "stale" })).toEqual({
      kind: "invalid",
    });
    expect(assistanceResponseOutcome(500, { agentId: "leaked" })).toEqual({
      kind: "error",
    });
  });

  test("removes a captured token from visible history only for its exact assistance URL", () => {
    expect(
      assistanceHistoryPath(
        "https://openbot.test/assist?token=sealed-control",
        "sealed-control",
      ),
    ).toBe("/assist");
    for (const href of [
      "https://openbot.test/assist?token=other",
      "https://openbot.test/assist?token=sealed-control&extra=1",
      "https://openbot.test/assist?token=sealed-control#fragment",
      "https://openbot.test/bot?token=sealed-control",
    ]) {
      expect(assistanceHistoryPath(href, "sealed-control")).toBeNull();
    }
  });

  test("captures and strips the token before any network outcome, retaining it for retry", () => {
    const writes: string[] = [];
    const storage = new Map<string, string>();
    const token = captureAssistanceToken(
      "sealed-control",
      "https://openbot.test/assist?token=sealed-control",
      { replace: (path) => writes.push(path) },
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    );
    expect(token).toBe("sealed-control");
    expect(writes).toEqual(["/assist"]);
    expect([...storage.values()]).toEqual(["sealed-control"]);
  });
});
