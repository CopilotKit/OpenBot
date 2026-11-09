/**
 * One turn of a built-in Bot on a Claude plan that asks the person a question, as the Intelligence
 * gateway replays it to a browser joining the conversation.
 *
 * Captured from a real run (OpenBot server and app, the agent-claude-sdk harness answering for the
 * plan, hosted Intelligence): the `ag_ui_event` frames the page received on its thread channel,
 * trimmed of the gateway's routing fields, the CUSTOM and STATE_SNAPSHOT frames and the closing
 * MESSAGES_SNAPSHOT, with the call's argument pieces joined into one. Ids, text pieces and their
 * order are as they arrived.
 */

const RUN = "bc71e551-ca13-47c4-9ca2-ba9aeb7f532f";
const CALL = "toolu_01GLfEAWRBaNa3A8dRmJFKYw";
const ASKING = "a11c5a54-9fa7-4aae-b4b6-864ff6ab78b0";
const ASKED = "65a96292-94fa-4fd9-80bf-6905da85f1a5";
const RESULT =
  "Put to the person in the source conversation; the question is saved awaiting their reply. Ask it in your own words now, plainly, and stop there: do not answer it yourself and do not hand it to another Bot.";

export const ASKING_TEXT = "I'll ask you now.";
export const ASKED_TEXT =
  "Which colour of apple do you prefer — red or green? I'll wait for your answer.";
/** Where the asked reply had got to when the join's deadline came, in the run that lost the rest. */
export const ASKED_SO_FAR = "Which colour of apple do";

/** The turn up to and including the first piece of the reply that follows the question. */
export function askPersonReplayStart(threadId: string): unknown[] {
  const event = (fields: Record<string, unknown>) => ({
    ...fields,
    threadId,
    runId: RUN,
  });
  return [
    event({ type: "RUN_STARTED" }),
    event({ type: "TEXT_MESSAGE_START", messageId: ASKING, role: "assistant" }),
    event({ type: "TEXT_MESSAGE_CONTENT", messageId: ASKING, delta: "I" }),
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ASKING,
      delta: "'ll ask you now",
    }),
    event({ type: "TEXT_MESSAGE_CONTENT", messageId: ASKING, delta: "." }),
    event({
      type: "TOOL_CALL_START",
      toolCallId: CALL,
      toolCallName: "ask_person",
      parentMessageId: ASKING,
    }),
    event({
      type: "TOOL_CALL_ARGS",
      toolCallId: CALL,
      delta:
        '{"question": "Which colour of apple do you prefer, red or green?", "why": "It\'s a personal preference only you can tell me.", "parts": [{"header": "Apple colour", "question": "Which colour of apple do you prefer?", "options": ["Red", "Green"]}]}',
    }),
    event({ type: "TOOL_CALL_END", toolCallId: CALL }),
    event({ type: "TEXT_MESSAGE_END", messageId: ASKING }),
    event({
      type: "TOOL_CALL_RESULT",
      messageId: "c0270a24-8e43-404c-a2ae-3b39c0a3ece3",
      role: "tool",
      toolCallId: CALL,
      content: RESULT,
    }),
    event({
      type: "TOOL_CALL_RESULT",
      messageId: `${CALL}-result`,
      role: "tool",
      toolCallId: CALL,
      content: RESULT,
    }),
    event({ type: "TEXT_MESSAGE_START", messageId: ASKED, role: "assistant" }),
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ASKED,
      delta: ASKED_SO_FAR,
    }),
  ];
}

/** The rest of the turn, after the first piece of its last reply. */
export function askPersonReplayEnd(threadId: string): unknown[] {
  const event = (fields: Record<string, unknown>) => ({
    ...fields,
    threadId,
    runId: RUN,
  });
  return [
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ASKED,
      delta: " you prefer — red or green",
    }),
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ASKED,
      delta: "? I'll wait for your",
    }),
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ASKED,
      delta: " answer.",
    }),
    event({ type: "TEXT_MESSAGE_END", messageId: ASKED }),
    event({ type: "RUN_FINISHED" }),
  ];
}

/**
 * The same turn as the thread's store answers for it: whole once the turn is over, and while it is
 * still being written, the reply as far as it has got.
 */
export function askPersonStored(
  userId: string,
  asked: string = ASKED_TEXT,
): unknown[] {
  return [
    {
      id: userId,
      role: "user",
      content:
        "Ask me with your question tool which colour of apple I prefer, red or green, then wait for my answer.",
    },
    {
      id: ASKING,
      role: "assistant",
      content: ASKING_TEXT,
      toolCalls: [
        {
          id: CALL,
          type: "function",
          function: {
            name: "ask_person",
            arguments:
              '{"question": "Which colour of apple do you prefer, red or green?"}',
          },
        },
      ],
    },
    {
      id: `${CALL}-result`,
      role: "tool",
      toolCallId: CALL,
      content: RESULT,
    },
    { id: ASKED, role: "assistant", content: asked },
  ];
}
