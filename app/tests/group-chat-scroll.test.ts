import { expect, test } from "bun:test";
import {
  isNearBottom,
  shouldFollowGroup,
} from "@/components/channels/group-chat";

/**
 * A group chat follows new lines only for a reader who is already at the bottom. Somebody scrolled
 * up to read an earlier answer keeps their place while the Bots go on talking below.
 */

test("80px from the bottom counts as at the bottom", () => {
  expect(
    isNearBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 0 }),
  ).toBe(true);
});

test("81px from the bottom does not", () => {
  expect(
    isNearBottom({ scrollTop: 919, scrollHeight: 1000, clientHeight: 0 }),
  ).toBe(false);
});

test("a custom threshold is respected", () => {
  expect(
    isNearBottom(
      { scrollTop: 700, scrollHeight: 1000, clientHeight: 100 },
      200,
    ),
  ).toBe(true);
  expect(
    isNearBottom(
      { scrollTop: 699, scrollHeight: 1000, clientHeight: 100 },
      200,
    ),
  ).toBe(false);
});

test("the first landing always goes to the bottom", () => {
  expect(
    shouldFollowGroup({ landed: false, atBottom: false, newestIsMine: false }),
  ).toBe(true);
});

test("a reader scrolled up keeps their place when a Bot speaks", () => {
  expect(
    shouldFollowGroup({ landed: true, atBottom: false, newestIsMine: false }),
  ).toBe(false);
});

test("the person's own message is always brought into view", () => {
  expect(
    shouldFollowGroup({ landed: true, atBottom: false, newestIsMine: true }),
  ).toBe(true);
});

test("a reader at the bottom follows", () => {
  expect(
    shouldFollowGroup({ landed: true, atBottom: true, newestIsMine: false }),
  ).toBe(true);
});
