import { expect, test } from "bun:test";
import {
  answerMessage,
  shownAnswer,
} from "@/components/approvals/question-notice";

/**
 * An answer typed in the conversation is drawn at once, under the id and in the words the server
 * stores it as, so the stored copy read back later is the same message rather than a second one. The
 * person sees only what they wrote: the question it quotes is for the Bot.
 */

const question = {
  id: "q1",
  botId: "assistant",
  threadId: "thread",
  channelId: "c1",
  question: "Which launch date should I use?",
  createdAt: "2026-11-04T10:00:00Z",
};

test("an answer is drawn under the id the server stores it as", () => {
  const message = answerMessage(question, "Nov 5");
  expect(message.id).toBe("person-response:q1");
  expect(message.content).toBe(
    "In response to your question: Which launch date should I use?\n\nNov 5",
  );
});

test("an answer shows only what the person wrote", () => {
  const shown = shownAnswer(answerMessage(question, "Nov 5\n\nand ship it"));
  expect(shown.content).toBe("Nov 5\n\nand ship it");
});

test("a message that merely reads like an answer is left alone", () => {
  const typed = {
    id: "m1",
    role: "user" as const,
    content: "In response to your question: yes\n\nNov 5",
  };
  expect(shownAnswer(typed)).toBe(typed);
});
