import { expect, test } from "bun:test";
import {
  listedQuestion,
  questionConversationBot,
  questionResponseMessage,
} from "../src/approvals/questions";

test("a delegated question response belongs to the original source Bot and includes the real question and answer", () => {
  const question = {
    actorId: "owner",
    botId: "delegate",
    sourceBotId: "source",
    channelId: "channel",
    threadId: "source-thread",
    runId: "delegated-run",
    question: "Which date should I use?",
    mode: "completed_question" as const,
  };
  expect(questionConversationBot(question)).toBe("source");
  expect(questionResponseMessage(question, "Friday", "response-id")).toEqual({
    id: "response-id",
    role: "user",
    content: "In response to your question: Which date should I use?\n\nFriday",
  });
  expect(questionConversationBot({ ...question, sourceBotId: undefined })).toBe(
    "delegate",
  );
});

test("a listed question names the Bot whose conversation it belongs to, not only the Bot that asked", () => {
  const createdAt = new Date("2026-10-09T10:00:00Z");
  const listed = listedQuestion({
    key: "q1",
    createdAt,
    payload: {
      actorId: "owner",
      botId: "delegate",
      sourceBotId: "source",
      channelId: "channel",
      threadId: "source-thread",
      runId: "delegated-run",
      question: "Which date should I use?",
      mode: "completed_question",
    },
  });
  expect(listed).toMatchObject({
    id: "q1",
    botId: "delegate",
    conversationBotId: "source",
    question: "Which date should I use?",
    createdAt,
  });
  expect(
    listedQuestion({ key: "q2", createdAt, payload: { nonsense: true } }),
  ).toBeNull();
});
