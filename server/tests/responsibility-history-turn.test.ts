import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { buildResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import { responsibilityHistory } from "@openbot/toolkit/responsibility-history";
import { createTurnRunner, turnMessages } from "@openbot/toolkit/run-turn";
import { EMPTY } from "rxjs";
import { serverTurnAdmission } from "../src/agents/turn-admission";

/**
 * Responsibility runs that share ONE thread, driven through the real turn runner against a thread
 * that remembers what each run persisted.
 *
 * The fake platform here is stateful on purpose: what one run persists is the history the next run
 * reads, which is the only way to see both halves of the change at once — what a run SENDS shrinks to
 * its own goal, and what the thread HOLDS still grows by exactly the new messages, with no
 * duplicates and nothing lost.
 */

const OWNER = "user_owner";
const AGENT_ID = "bot_watcher";
const THREAD_ID = "thread_owner_channel";

type Row = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

class FakeAgent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

/** Message (AG-UI) back into the platform's row shape, as the gateway would store it. */
function toRow(message: Message): Row {
  const toolCalls =
    message.role === "assistant"
      ? message.toolCalls?.map((call) => ({
          id: call.id,
          name: call.function.name,
          args: call.function.arguments,
        }))
      : undefined;
  return {
    id: message.id,
    role: message.role,
    content: (message as { content?: unknown }).content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
  };
}

function platform() {
  const thread: Row[] = [];
  const duplicates: string[] = [];
  const sent: { runId: string; ids: string[] }[] = [];
  const store = (message: Message) => {
    if (thread.some((row) => row.id === message.id))
      duplicates.push(message.id);
    else thread.push(toRow(message));
  };

  const intelligence = {
    getOrCreateThread: async () => ({ created: false }),
    getThreadMessages: async () => ({ messages: structuredClone(thread) }),
    ɵacquireThreadLock: async () => ({}),
    ɵrenewThreadLock: async () => ({}),
    ɵcleanupThreadLock: async () => undefined,
  };

  const runner = {
    run: (request: {
      agent: FakeAgent;
      input: { runId: string; messages: Message[] };
      persistedInputMessages?: Message[];
    }) => ({
      subscribe(observer: { complete: () => void }) {
        const { agent, input } = request;
        // What the model is sent is what `runAgent` reads off the agent.
        sent.push({ runId: input.runId, ids: agent.messages.map((m) => m.id) });
        for (const message of request.persistedInputMessages ?? input.messages)
          store(message);
        const prefix = input.runId;
        const answer = [
          {
            id: `${prefix}-call`,
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: `${prefix}-tc`,
                type: "function",
                function: {
                  name: "report_responsibility_progress",
                  arguments: "{}",
                },
              },
            ],
          },
          {
            id: `${prefix}-result`,
            role: "tool",
            toolCallId: `${prefix}-tc`,
            content: "recorded",
          },
          { id: `${prefix}-reply`, role: "assistant", content: "Not yet." },
        ] as Message[];
        agent.messages = [...agent.messages, ...answer];
        for (const message of answer) store(message);
        observer.complete();
        return { unsubscribe: () => undefined };
      },
    }),
    stop: async () => true,
  };

  const runTurn = createTurnRunner({
    admission: serverTurnAdmission,
    // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
    intelligence: intelligence as any,
    // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
    runner: runner as any,
    buildAgentFor: async () => new FakeAgent({ agentId: AGENT_ID }),
  });

  /** One run of a goal, with the goal's own history filter, as the responsibility wiring passes it. */
  const fire = (responsibilityId: string, runId: string, filtered = true) =>
    runTurn({
      ownerUserId: OWNER,
      routineId: responsibilityId,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      runId,
      instruction: buildResponsibilityTurn({
        instruction: `Watch ${responsibilityId}.`,
        successCriteria: "Clean.",
        progress: "",
        trigger: { source: "webhook", type: "event" },
        eventData: "<untrusted>{}</untrusted>",
        responsibilityId,
      }),
      ...(filtered
        ? {
            historyFilter: (history: Message[]) =>
              responsibilityHistory(history, responsibilityId),
          }
        : {}),
    });

  /** The person typing into the same channel, persisted the way a chat turn would. */
  const chat = (id: string) => {
    store({ id, role: "user", content: "How are the PRs?" } as Message);
    store({
      id: `${id}-reply`,
      role: "assistant",
      content: "Fine.",
    } as Message);
  };

  return { fire, chat, thread, duplicates, sent };
}

describe("a responsibility run on a thread shared with other goals", () => {
  test("sends only its own goal's earlier runs, while the thread keeps every message once", async () => {
    const { fire, chat, thread, duplicates, sent } = platform();

    await fire("goal-a", "a1");
    await fire("goal-b", "b1");
    chat("person1");
    await fire("goal-a", "a2");
    await fire("goal-b", "b2");
    await fire("goal-a", "a3");

    const count = (runId: string) =>
      sent.find((entry) => entry.runId === runId)?.ids.length;
    // Each run: one firing plus three answer messages. A run sends its own goal's earlier runs and
    // its own firing — never the other goal's runs, never the person's chat.
    expect(count("a1")).toBe(1);
    expect(count("b1")).toBe(1);
    expect(count("a2")).toBe(5);
    expect(count("b2")).toBe(5);
    expect(count("a3")).toBe(9);

    const b2 = sent.find((entry) => entry.runId === "b2")?.ids ?? [];
    expect(b2.some((id) => id.startsWith("a"))).toBe(false);
    expect(b2.some((id) => id.startsWith("person"))).toBe(false);

    // Persisting is unchanged: 5 runs of 4 messages plus the person's 2, each exactly once.
    expect(duplicates).toEqual([]);
    expect(thread).toHaveLength(5 * 4 + 2);
    expect(new Set(thread.map((row) => row.id)).size).toBe(thread.length);
    expect(thread.map((row) => row.id)).toEqual(
      expect.arrayContaining(["a1-reply", "b1-reply", "person1", "a3-reply"]),
    );
  });

  test("a turn without a filter still sends the whole thread, as routines and chat do", async () => {
    const { fire, chat, sent } = platform();
    await fire("goal-a", "a1");
    chat("person1");
    await fire("goal-b", "b1", false);
    // Unfiltered: goal-a's four messages, the person's two, and its own firing.
    expect(sent.find((entry) => entry.runId === "b1")?.ids).toHaveLength(7);
  });

  test("a retried firing already in the thread is neither sent twice nor persisted again", () => {
    const firing = {
      id: "a1",
      role: "user",
      content: buildResponsibilityTurn({
        instruction: "Watch goal-a.",
        successCriteria: "Clean.",
        progress: "",
        trigger: { source: "webhook", type: "event" },
        eventData: "<untrusted>{}</untrusted>",
        responsibilityId: "goal-a",
      }),
    } as Message;
    const other = { id: "b1", role: "user", content: "How are the PRs?" };
    const history = [other, firing] as Message[];

    const { messages, persistedInputMessages } = turnMessages({
      seeded: responsibilityHistory(history, "goal-a"),
      historicIds: new Set(history.map((message) => message.id)),
      turn: firing,
    });

    expect(messages.map((message) => message.id)).toEqual(["a1"]);
    expect(persistedInputMessages).toEqual([]);
  });

  test("a continuation persists only its tool result, whatever the filter left out", () => {
    const { persistedInputMessages } = turnMessages({
      seeded: [],
      historicIds: new Set(["a1", "a1-call", "b1"]),
      turn: { id: "unused", role: "user", content: "" } as Message,
      continuation: {
        snapshot: {
          threadId: THREAD_ID,
          toolCallId: "a1-tc",
          messages: [
            { id: "a1", role: "user", content: "firing" },
            {
              id: "a1-call",
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "a1-tc",
                  type: "function",
                  function: { name: "ask", arguments: "{}" },
                },
              ],
            },
          ],
        } as never,
        result: { content: "yes" },
        messageId: "a1-result",
      },
    });

    expect(persistedInputMessages.map((message) => message.id)).toEqual([
      "a1-result",
    ]);
  });
});
