import { expect, test } from "bun:test";
import { createAllowList } from "./allow-list";

test("only listed chats are allow-listed", () => {
  const allow = createAllowList(["1"]);
  expect(allow.has("1")).toBe(true);
  expect(allow.has("2")).toBe(false);
  allow.add("2");
  expect(allow.has("2")).toBe(true);
  expect(allow.size()).toBe(2);
  allow.clear();
  expect(allow.size()).toBe(0);
});
