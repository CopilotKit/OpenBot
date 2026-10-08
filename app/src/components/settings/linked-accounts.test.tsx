import { expect, test } from "bun:test";
import { linkedAccountDescription } from "./linked-accounts";

const base = {
  id: "1",
  provider: "github" as const,
  title: "GitHub",
  createdAt: "2026-10-08T00:00:00.000Z",
};

test("an active link shows its handle", () => {
  expect(
    linkedAccountDescription({ ...base, handle: "dana", status: "active" }),
  ).toBe("@dana");
});

test("a link without a handle says it is linked", () => {
  expect(
    linkedAccountDescription({ ...base, handle: null, status: "active" }),
  ).toBe("Linked");
});

test("a link needing reconnection says so first", () => {
  expect(
    linkedAccountDescription({
      ...base,
      handle: "dana",
      status: "needs_reconnect",
    }),
  ).toBe("Needs reconnecting · @dana");
});
