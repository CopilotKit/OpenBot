import { expect, test } from "bun:test";
import {
  gestureForRecording,
  safeDemonstrationUrl,
} from "../src/demonstration";

test("passwords, pasted text and printable key values are never part of a recorded gesture", () => {
  expect(
    gestureForRecording({ type: "text", text: "secret-password" }),
  ).toEqual({ kind: "type" });
  expect(
    gestureForRecording({
      type: "key",
      event: "down",
      key: "s",
      code: "KeyS",
      text: "s",
    }),
  ).toEqual({ kind: "type" });
});
test("pointer movement and releases are not false completed actions", () => {
  expect(
    gestureForRecording({ type: "mouse", event: "moved", x: 1, y: 2 }),
  ).toBeNull();
  expect(
    gestureForRecording({
      type: "key",
      event: "up",
      key: "Enter",
      code: "Enter",
    }),
  ).toBeNull();
});
test("URL provenance omits credentials, query tokens and fragments", () => {
  expect(
    safeDemonstrationUrl(
      "https://user:password@example.test/form?token=secret#secret",
    ),
  ).toBe("https://example.test/form");
});
