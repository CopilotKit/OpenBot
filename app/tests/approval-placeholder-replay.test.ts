import { expect, test } from "bun:test";
import { DECLINED_BY_PERSON } from "@openbot/shared/approval-outcomes";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { Observable } from "rxjs";
import { readOutcome } from "@/lib/computers/activity";
import { observeApprovalAgent } from "@/lib/copilot/approval-context";

/**
 * A step the person was asked about, then declined, must still read as declined when its
 * conversation is opened again.
 *
 * What happened on the Mac: the Bot asked to save a file, the gate held it, and the browser's
 * handler answered the SDK with the `{ waiting: true }` placeholder, which the SDK put in the
 * conversation as the call's tool message. The person pressed Deny; the server's continuation
 * answered the call with the decline, and the chat said "Blocked: Saved file. You declined it."
 * Then the person wrote again. That run sent the placeholder along with everything else, as a
 * message the thread did not hold yet, so the runtime saved it, and the thread kept it as the
 * call's answer in place of the decline. Opened again, the transcript read `{ waiting: true }` as
 * no answer at all and drew the declined step as "Saved file", done.
 *
 * The thread's own record is played by `Thread` below, as the platform behaved on the Mac: a run
 * saves the input messages the thread does not already hold (the runtime's `persistedInputMessages`,
 * the id subtraction in `handlers/intelligence/run.mjs`), and a tool message for a call that already
 * has one takes its place.
 */

const CALL = "toolu_write";
const HISTORY: Message[] = [
  { id: "user-1", role: "user", content: "Save a file called notes.txt." },
  {
    id: "assistant-1",
    role: "assistant",
    content: "I'll save that file now.",
    toolCalls: [
      {
        id: CALL,
        type: "function",
        function: {
          name: "computer_write_file",
          arguments: JSON.stringify({ path: "notes.txt", contents: "hi" }),
        },
      },
    ],
  },
  // The continuation's answer, as the thread holds it after the decision.
  {
    id: `${CALL}-result`,
    role: "tool",
    toolCallId: CALL,
    content: DECLINED_BY_PERSON,
  },
  {
    id: "assistant-2",
    role: "assistant",
    content: "I didn't save notes.txt, because you declined it.",
  },
];

/** The thread as the platform keeps it. */
class Thread {
  messages: Message[] = structuredClone(HISTORY);
  save(input: Message[]) {
    const held = new Set(this.messages.map((message) => message.id));
    for (const message of input.filter((message) => !held.has(message.id))) {
      if (message.role === "tool")
        this.messages = this.messages.filter(
          (saved) =>
            saved.role !== "tool" || saved.toolCallId !== message.toolCallId,
        );
      this.messages.push(message);
    }
  }
  /** What the transcript reads for the call when the conversation is opened again. */
  outcomeOf(toolCallId: string) {
    const answer = this.messages.find(
      (message) => message.role === "tool" && message.toolCallId === toolCallId,
    );
    return readOutcome(answer?.content);
  }
}

/** A Bot that answers every run with a short reply, after the thread saves what it was sent. */
class Bot extends AbstractAgent {
  constructor(private thread: Thread) {
    super({ agentId: "bot", threadId: "thread-1" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.thread.save(input.messages);
    return new Observable<BaseEvent>((subscriber) => {
      const ids = { threadId: input.threadId, runId: input.runId };
      subscriber.next({ type: EventType.RUN_STARTED, ...ids } as BaseEvent);
      subscriber.next({ type: EventType.RUN_FINISHED, ...ids } as BaseEvent);
      subscriber.complete();
    });
  }
}

test("a declined step still reads as declined after the person writes again", async () => {
  const thread = new Thread();
  const bot = new Bot(thread);
  // The browser's copy: the placeholder the SDK inserted right after the call, then the rest.
  bot.messages = [
    ...structuredClone(HISTORY.slice(0, 2)),
    {
      id: "placeholder-1",
      role: "tool",
      toolCallId: CALL,
      content: JSON.stringify({ waiting: true }),
    },
    ...structuredClone(HISTORY.slice(2)),
    { id: "user-2", role: "user", content: "Thanks. What's 7+1?" },
  ];
  const release = observeApprovalAgent(bot as never);

  await bot.runAgent();

  // The decline is still the call's answer, so the transcript draws the step as declined.
  expect(thread.outcomeOf(CALL)).toMatchObject({
    ok: false,
    refused: true,
    declined: true,
  });
  // And the browser's own copy no longer carries a placeholder to send again.
  expect(
    bot.messages.filter(
      (message) => message.role === "tool" && message.toolCallId === CALL,
    ),
  ).toEqual([
    {
      id: `${CALL}-result`,
      role: "tool",
      toolCallId: CALL,
      content: DECLINED_BY_PERSON,
    },
  ]);
  release();
});

test("a step still waiting for the person is not sent with a placeholder for an answer", async () => {
  const thread = new Thread();
  thread.messages = structuredClone(HISTORY.slice(0, 2));
  const bot = new Bot(thread);
  bot.messages = [
    ...structuredClone(HISTORY.slice(0, 2)),
    {
      id: "placeholder-1",
      role: "tool",
      toolCallId: CALL,
      content: JSON.stringify({ waiting: true }),
    },
    { id: "user-2", role: "user", content: "While you wait: what's 7+1?" },
  ];
  const release = observeApprovalAgent(bot as never);

  await bot.runAgent();

  // Nothing answers the call yet; the decision, when it comes, is the first answer it gets.
  expect(
    thread.messages.some(
      (message) => message.role === "tool" && message.toolCallId === CALL,
    ),
  ).toBe(false);
  release();
});
