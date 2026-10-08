import { expect, test } from "bun:test";
import { confirmLinkState } from "./link-state";

const idle = { status: "idle" as const };
const token = "a".repeat(43);

test("no or malformed token is invalid", () => {
  expect(
    confirmLinkState({
      token: undefined,
      peek: { status: "pending" },
      confirm: idle,
    }).kind,
  ).toBe("invalid");
  expect(
    confirmLinkState({
      token: "short",
      peek: { status: "pending" },
      confirm: idle,
    }).kind,
  ).toBe("invalid");
});

test("peek pending is loading; peek error is expired", () => {
  expect(
    confirmLinkState({ token, peek: { status: "pending" }, confirm: idle })
      .kind,
  ).toBe("loading");
  expect(
    confirmLinkState({ token, peek: { status: "error" }, confirm: idle }).kind,
  ).toBe("expired");
});

test("a live challenge is ready and names its provider", () => {
  expect(
    confirmLinkState({
      token,
      peek: { status: "success", data: { title: "Slack" } },
      confirm: idle,
    }),
  ).toEqual({ kind: "ready", title: "Slack" });
});

test("confirm states", () => {
  const peek = { status: "success" as const, data: { title: "Slack" } };
  expect(
    confirmLinkState({ token, peek, confirm: { status: "pending" } }).kind,
  ).toBe("confirming");
  expect(
    confirmLinkState({ token, peek, confirm: { status: "error" } }).kind,
  ).toBe("failed");
  expect(
    confirmLinkState({
      token,
      peek,
      confirm: { status: "success", hint: "do X" },
    }),
  ).toEqual({ kind: "done", title: "Slack", hint: "do X" });
});
