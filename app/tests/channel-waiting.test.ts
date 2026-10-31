import { expect, test } from "bun:test";
import type { ApprovalInboxData } from "../src/lib/approvals";
import { waitingThreadIds } from "../src/lib/channels/waiting";

type Request = ApprovalInboxData["requests"][number];
type Question = ApprovalInboxData["questions"][number];

function request(id: string, threadId: string, status: string): Request {
  return {
    id,
    status,
    createdAt: "2026-10-29T12:00:00.000Z",
    action: {
      botId: "bot-1",
      toolRef: "gmail.send",
      effect: "send",
      scope: "*",
      threadId,
      args: {},
      target: null,
    },
  };
}

function question(id: string, threadId: string): Question {
  return {
    id,
    botId: "bot-1",
    threadId,
    question: "Which account?",
    createdAt: "2026-10-29T12:00:00.000Z",
  };
}

function inbox(requests: Request[], questions: Question[]): ApprovalInboxData {
  return { enabled: true, requests, rules: [], teamRules: [], questions };
}

test("a pending request and a question each mark their conversation as waiting", () => {
  const ids = waitingThreadIds(
    inbox(
      [request("r1", "thread-approval", "pending")],
      [question("q1", "thread-question")],
    ),
  );
  expect([...ids].sort()).toEqual(["thread-approval", "thread-question"]);
});

test("a resolved request waits on nobody", () => {
  const ids = waitingThreadIds(
    inbox(
      [
        request("r1", "thread-allowed", "allowed"),
        request("r2", "thread-denied", "denied"),
      ],
      [],
    ),
  );
  expect(ids.size).toBe(0);
});

test("an inbox not loaded yet marks nothing", () => {
  expect(waitingThreadIds(undefined).size).toBe(0);
});
