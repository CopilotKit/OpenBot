/**
 * A notification about the conversation the phone is showing shows nothing: the screen already has
 * it. One about another conversation, or one that arrives once the person has left the screen, shows
 * as any other.
 */
import { expect, test } from "bun:test";
import {
  aboutShownConversation,
  conversationOf,
  showConversation,
} from "../src/on-screen";

const about = (channelId: unknown) => ({
  kind: "reply",
  channelId,
  url: `openbotmobile://conversation?channelId=${channelId}`,
});

test("a notification about the conversation on screen is that one's, and no other's", () => {
  expect(aboutShownConversation(about("c1"))).toBe(false);
  const leave = showConversation("c1");
  expect(aboutShownConversation(about("c1"))).toBe(true);
  expect(aboutShownConversation(about("c2"))).toBe(false);
  // A ping folds several Bots' items and names no conversation.
  expect(
    aboutShownConversation({
      kind: "attention",
      url: "openbotmobile://needs-you",
    }),
  ).toBe(false);
  leave();
  expect(aboutShownConversation(about("c1"))).toBe(false);
});

test("leaving a conversation does not clear the one opened after it", () => {
  const leaveFirst = showConversation("c1");
  const leaveSecond = showConversation("c2");
  leaveFirst();
  expect(aboutShownConversation(about("c2"))).toBe(true);
  leaveSecond();
  expect(aboutShownConversation(about("c2"))).toBe(false);
});

test("only a conversation id the server wrote as text counts", () => {
  expect(conversationOf(about("c1"))).toBe("c1");
  expect(conversationOf(about(""))).toBeNull();
  expect(conversationOf(about(7))).toBeNull();
  expect(conversationOf(null)).toBeNull();
  expect(conversationOf("c1")).toBeNull();
});
