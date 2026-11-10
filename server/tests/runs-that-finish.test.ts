import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { LAST_STEP_NOTICE } from "@openbot/shared/run-notices";
import { UNATTENDED_STEPS } from "@openbot/toolkit/copilotkit/last-step";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { AuditInitiator } from "@openbot/toolkit/initiator";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { RuntimeModel } from "../src/copilot";

/*
 * Runs that finish.
 *
 * FOUND ON A TEAMMATE'S ROUTINE: about twenty lookups across Linear and Notion on a built-in Bot.
 * It had eight steps, the eighth was sent with its tools switched off and nothing saying so, and the
 * run ended "I'll fetch the rest now" with no call after it. So a run's last step now says tools are
 * off and to answer from what it has; a run that ends on a promise, or with a routine's part still
 * open, is sent back to work, at most twice in a row; and a routine gets a step budget for the work.
 *
 * Driven through the path a run takes: the Bot built by the actor resolver (the server's
 * `buildAgents`), its granted tool executed by the AI SDK, the model a real OpenAI-compatible HTTP
 * server (aimock) speaking the provider's own wire format, and a routine's turn through the headless
 * turn runner exactly as a firing reaches it.
 */

const model: RuntimeModel = {
  provider: "openai",
  defaultModel: "gpt-5.6-terra",
};
const bot = {
  id: "planner",
  name: "Planner",
  type: "built_in" as const,
  systemPrompt: "Plan the cycle.",
};

let llm: LLMock;
let originalBase: string | undefined;
/** Every request the model was sent, in order, as the provider received it. */
let asked: ChatCompletionRequest[];
/** Every lookup the Bot's tool was asked for. */
let lookups: string[];

beforeEach(async () => {
  llm = new LLMock();
  asked = [];
  lookups = [];
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
});

afterEach(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await llm.stop();
});

/** The model, answering each request with what `answer` says. */
function modelAnswers(
  answer: (
    request: ChatCompletionRequest,
    index: number,
  ) =>
    | { content: string }
    | { toolCalls: { name: string; arguments: string; id?: string }[] },
) {
  llm.on({ predicate: () => true }, (request) => {
    asked.push(request);
    return answer(request, asked.length - 1);
  });
}

const lookup: GrantedTool = {
  name: "lookup_issue",
  description: "Look up one issue by its id.",
  parameters: z.object({ id: z.string() }),
  ref: "linear/lookup_issue",
  execute: async (args) => {
    const { id } = args as { id: string };
    lookups.push(id);
    return JSON.stringify({ id, title: `Issue ${id}`, state: "Todo" });
  },
};

function resolver() {
  return createActorAgentResolver({
    loadAgents: async () => [bot],
    model,
    resolveModelApiKey: async () => "synthetic-key",
    loadToolsForActor: () => async () => [lookup],
  });
}

/** A person's chat run with the Bot, and what it left in the conversation. */
async function chat(text: string): Promise<Message[]> {
  const agent = await resolver().resolveAgentForActor(
    { id: "owner", role: "user" },
    bot.id,
  );
  const run = agent.clone() as AbstractAgent;
  run.threadId = "thread-chat";
  run.setMessages([{ id: "ask", role: "user", content: text }]);
  await run.runAgent();
  return run.messages;
}

/** A routine's firing, through the headless turn runner, as the routine runner calls it. */
async function fire(
  instruction: string,
  initiator: AuditInitiator = { kind: "routine", id: "routine-cycle" },
) {
  const runTurn = createTurnRunner({
    admission: async () => new AbortController().signal,
    intelligence: {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => undefined,
      ɵrenewThreadLock: async () => undefined,
      ɵcleanupThreadLock: async () => undefined,
    },
    runner: {
      run: ({ agent, input }) =>
        new Observable((subscriber) => {
          agent
            .runAgent(input, {
              onEvent: ({ event }) => subscriber.next(event),
            })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        }),
      stop: async () => true,
    },
    // What the server's `buildAgentFor` calls for a routine.
    buildAgentFor: ({ ownerUserId, agentId, initiator }) =>
      resolver().resolveAgentForActor(
        { id: ownerUserId, role: "user" },
        agentId,
        { initiator },
      ),
  });
  return runTurn({
    ownerUserId: "owner",
    routineId: "routine-cycle",
    agentId: bot.id,
    threadId: "thread-routine",
    instruction,
    initiator,
  });
}

const lastMessage = (request: ChatCompletionRequest) => request.messages.at(-1);
const textOf = (request: ChatCompletionRequest | undefined) =>
  JSON.stringify(request?.messages ?? []);
const offersTools = (request: ChatCompletionRequest) =>
  request.tool_choice !== "none";
const toolCall = (id: string, n: number) => ({
  toolCalls: [
    { name: lookup.name, arguments: JSON.stringify({ id }), id: `call_${n}` },
  ],
});

describe("a run's last step", () => {
  test("tells the model its tools are off and to answer from what it has", async () => {
    modelAnswers((request, index) =>
      offersTools(request)
        ? toolCall(`ENG-${index + 1}`, index)
        : {
            content:
              "Here are the seven issues I read. I did not get to ENG-8 onward: I ran out of steps.",
          },
    );

    const messages = await chat("Look up every issue in the cycle.");

    // Chat keeps its eight steps: seven with tools, the eighth without.
    expect(asked).toHaveLength(8);
    expect(asked.slice(0, 7).every(offersTools)).toBe(true);
    const last = asked[7];
    expect(last?.tool_choice).toBe("none");
    // Said to the model, as the last thing on the step that has no tools.
    expect(lastMessage(last as ChatCompletionRequest)).toMatchObject({
      role: "user",
    });
    expect(
      JSON.stringify(lastMessage(last as ChatCompletionRequest)),
    ).toContain(LAST_STEP_NOTICE);
    // No earlier step was told.
    for (const request of asked.slice(0, 7))
      expect(textOf(request)).not.toContain(LAST_STEP_NOTICE);
    // And never written into the conversation.
    expect(JSON.stringify(messages)).not.toContain(LAST_STEP_NOTICE);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("I did not get to ENG-8"),
    });
  });

  test("a routine's run gets a budget for the work, well above chat's eight", async () => {
    modelAnswers((request, index) =>
      offersTools(request)
        ? toolCall(`ENG-${index + 1}`, index)
        : { content: "Done what I could. Could not confirm the rest." },
    );

    const { replyText } = await fire(
      "Look up every issue in the current cycle.",
    );

    expect(asked).toHaveLength(UNATTENDED_STEPS.base);
    expect(lookups).toHaveLength(UNATTENDED_STEPS.base - 1);
    expect(asked.at(-1)?.tool_choice).toBe("none");
    expect(textOf(asked.at(-1))).toContain(LAST_STEP_NOTICE);
    expect(replyText).toContain("Could not confirm the rest.");
  });
  test("every run told it runs unattended gets the same budget: a goal's run too", async () => {
    modelAnswers((request, index) =>
      offersTools(request)
        ? toolCall(`ENG-${index + 1}`, index)
        : { content: "Done what I could. Could not confirm the rest." },
    );

    // A goal's run is told nobody is watching (`runModeOf`), so it has the steps to finish.
    await fire("Look up every issue in the current cycle.", {
      kind: "responsibility",
      id: "goal-cycle",
    });

    const told = JSON.stringify(asked[0]?.messages ?? []);
    expect(told).toContain("run_mode");
    expect(asked).toHaveLength(UNATTENDED_STEPS.base);
    expect(asked.at(-1)?.tool_choice).toBe("none");
  });
});

describe("a run that ends on a promise", () => {
  test("is sent back once, calls the tool it promised, and answers", async () => {
    modelAnswers((request) => {
      const last = JSON.stringify(lastMessage(request));
      if (last.includes("made no tool call")) return toolCall("ENG-2", 2);
      if (lastMessage(request)?.role === "tool")
        return { content: "Both issues are in Todo: ENG-1 and ENG-2." };
      return {
        content: "I read ENG-1. I'll fetch the rest now.",
      };
    });

    const messages = await chat("Check ENG-1 and ENG-2.");

    expect(asked).toHaveLength(3);
    // The nudge quotes the promise back and offers the way out.
    expect(
      JSON.stringify(lastMessage(asked[1] as ChatCompletionRequest)),
    ).toContain(
      'You said \\"I\'ll fetch the rest now.\\" but made no tool call. Do it now, or finish with the result and what is missing.',
    );
    expect(lookups).toEqual(["ENG-2"]);
    // The nudge was for the model only: the conversation holds what the Bot said and did.
    expect(JSON.stringify(messages)).not.toContain("made no tool call");
    const said = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content ?? "")
      .join("\n");
    expect(said).toContain("I'll fetch the rest now.");
    expect(said).toContain("Both issues are in Todo");
  });

  test("is sent back at most twice in a row, then the run ends", async () => {
    modelAnswers(() => ({ content: "I'll fetch the rest now." }));

    const messages = await chat("Check ENG-1 and ENG-2.");

    expect(asked).toHaveLength(1 + 2);
    expect(lookups).toEqual([]);
    // Each ask's words are set apart from the last, not run together into one sentence.
    const said = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content ?? "")
      .join("");
    expect(said).not.toContain("now.I'll");
    expect(said).toContain(
      "I'll fetch the rest now.\n\nI'll fetch the rest now.",
    );
  });

  test("is counted again from nothing after a tool call", async () => {
    // Promise, nudge, call; then promise, nudge, promise, nudge, promise: let go.
    const script = [
      { content: "Let me look that up." },
      toolCall("ENG-1", 1),
      { content: "Got ENG-1. Next I'll pull ENG-2." },
      { content: "Pulling ENG-2 now." },
      { content: "I will fetch ENG-2 now." },
    ];
    modelAnswers((_request, index) => script[index] ?? { content: "?" });

    await chat("Check ENG-1 and ENG-2.");

    expect(asked).toHaveLength(script.length);
    expect(lookups).toEqual(["ENG-1"]);
    const nudged = asked.filter((request) =>
      JSON.stringify(lastMessage(request)).includes("made no tool call"),
    );
    expect(nudged).toHaveLength(3);
  });

  test("a question to the person is theirs to answer, and is not sent back", async () => {
    modelAnswers(() => ({
      content: "I found ENG-1. Do you want me to fetch the rest as well?",
    }));

    await chat("Check ENG-1.");

    expect(asked).toHaveLength(1);
  });

  test("an answer that is finished is not sent back", async () => {
    modelAnswers(() => ({
      content: "ENG-1 is in Todo. Let me know if you need anything else.",
    }));

    await chat("Check ENG-1.");

    expect(asked).toHaveLength(1);
  });
});

describe("a multi-part routine", () => {
  const instruction = [
    "Every Monday, plan the cycle:",
    "1. Pull the current cycle's issues from Linear",
    "2. Match them against the Candidates page in Notion",
    "3. Rank what is left by priority and post the list here",
  ].join("\n");

  test("carries its checklist and does not end with a part open", async () => {
    modelAnswers((request) => {
      const last = JSON.stringify(lastMessage(request));
      if (last.includes("still open"))
        return {
          content: [
            "2. Done: 9 of 14 issues are on the Candidates page.",
            "3. Blocked: the Candidates page has no priorities to rank by.",
          ].join("\n"),
        };
      return { content: "1. Done: pulled 14 issues from the current cycle." };
    });

    const { replyText } = await fire(instruction);

    // The firing reached the model with its parts listed, numbered as they are to be closed.
    expect(textOf(asked[0])).toContain("This routine has 3 parts.");
    expect(asked).toHaveLength(2);
    const nudge = JSON.stringify(
      lastMessage(asked[1] as ChatCompletionRequest),
    );
    expect(nudge).toContain(
      "2. Match them against the Candidates page in Notion",
    );
    expect(nudge).toContain("3. Rank what is left");
    expect(nudge).not.toContain("1. Pull");
    expect(replyText).toContain("1. Done");
    expect(replyText).toContain("3. Blocked");
  });

  test("a routine whose answer closes every part ends as it is", async () => {
    modelAnswers(() => ({
      content: [
        "1. Done: pulled 14 issues.",
        "2. Done: 9 matched.",
        "3. Skipped: nothing left to rank.",
      ].join("\n"),
    }));

    await fire(instruction);

    expect(asked).toHaveLength(1);
  });

  test("gets more steps for each part", async () => {
    modelAnswers((request, index) =>
      offersTools(request)
        ? toolCall(`ENG-${index + 1}`, index)
        : {
            content:
              "1. Done\n2. Blocked: out of steps\n3. Skipped: out of steps",
          },
    );

    await fire(instruction);

    expect(asked).toHaveLength(
      UNATTENDED_STEPS.base + 3 * UNATTENDED_STEPS.perPart,
    );
    expect(textOf(asked.at(-1))).toContain(LAST_STEP_NOTICE);
  });
});
