import { expect, test } from "bun:test";
import { AbstractAgent, type Message, type RunAgentInput } from "@ag-ui/client";
import { EMPTY } from "rxjs";
import { createTurnRunner } from "../src/routines/run-turn";

class Agent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}
test("verified inbound person message keeps canonical run ID and persists exact text without routine frame", async () => {
  const agent = new Agent({ agentId: "bot" });
  const locks: string[] = [];
  const persisted: Message[][] = [];
  const initiators: unknown[] = [];
  const intelligence = {
    getOrCreateThread: async () => ({}),
    getThreadMessages: async () => ({
      messages: [{ id: "old", role: "user", content: "Earlier" }],
    }),
    ɵacquireThreadLock: async (input: { runId: string; threadId: string }) => {
      locks.push(input.runId);
      return { ...input, joinToken: "token" };
    },
    ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
    ɵcleanupThreadLock: async (input: { runId: string }) => {
      locks.push(input.runId);
    },
  };
  const runner = {
    run: (input: {
      input: RunAgentInput;
      persistedInputMessages?: Message[];
    }) => ({
      subscribe(observer: { complete(): void }) {
        locks.push(input.input.runId);
        persisted.push(input.persistedInputMessages ?? []);
        agent.setMessages([
          ...agent.messages,
          { id: "reply", role: "assistant", content: "Hello" },
        ]);
        observer.complete();
        return {};
      },
    }),
    stop: async () => true,
  };
  const turn = createTurnRunner({
    intelligence,
    runner,
    buildAgentFor: async (input) => {
      initiators.push(input.initiator);
      return agent;
    },
  });
  const userMessage: Message = {
    id: "delivery:inbox-id",
    role: "user",
    content: "My actual Slack message",
  };
  expect(
    await turn({
      ownerUserId: "owner",
      routineId: "delivery:inbox-id",
      runId: "inbox-id",
      agentId: "bot",
      threadId: "canonical-thread",
      instruction: userMessage.content,
      userMessage,
      initiator: { kind: "person" },
    }),
  ).toEqual({ replyText: "Hello" });
  expect(locks).toEqual(["inbox-id", "inbox-id", "inbox-id"]);
  expect(persisted).toEqual([[userMessage]]);
  expect(initiators).toEqual([{ kind: "person" }]);
  expect(agent.threadId).toBe("canonical-thread");
});
