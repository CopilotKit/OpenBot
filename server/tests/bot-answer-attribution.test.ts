import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { answerMessageId } from "@openbot/shared/handoff-markers";
import {
  chooseOpenAIApi,
  normalizeModelBaseUrls,
  type RuntimeModel,
  registeredAgentFromRow,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
} from "../src/copilot";
import { loadTenantPackage } from "../src/tenant-package";
import {
  type OpenAICompatibleEndpoint,
  startOpenAICompatibleEndpoint,
} from "./support/openai-compatible-endpoint";

/**
 * What a built-in Bot's model is sent about who said what.
 *
 * Found in an end-to-end run. General Assistant used `message_bot` to ask Knowledge, and Knowledge's
 * answer appeared on screen under Knowledge's name. Asked next to "quote exactly what the Knowledge
 * Bot answered", General Assistant said Knowledge's reply never appeared in the conversation and that
 * the sentence was its own. The answer is stored in the asking Bot's thread as an assistant message
 * whose id names Knowledge, and the model was sent it as an ordinary assistant turn.
 *
 * And from the home composer: "ask the Knowledge Bot for one sentence on what Helm is" was routed to
 * Knowledge, rightly, and Knowledge went looking for a way to reach the Knowledge Bot, because
 * nothing it was sent told it its own name.
 *
 * Real: the package's model, both Bots built as the server builds them, and the request on the wire
 * to a model endpoint that answers in OpenAI's recorded bytes. Read: the conversation that request
 * carried, which is the only place the question "what was the model told" has an answer.
 */

const KNOWLEDGE = "knowledge";
const ASKER = "general-assistant";
/** What Knowledge said, in the run that found this. */
const KNOWLEDGE_ANSWER =
  "Helm is a package manager for Kubernetes that installs and upgrades applications from versioned charts.";
const ASKED = "Ask the Knowledge Bot for one sentence on what Helm is.";
const QUOTE = "Quote exactly what the Knowledge Bot answered.";

const VARIABLES = [
  "OPENAI_BASE_URL",
  "BOT_MODEL",
  "BOT_PROVIDER",
  "COPILOTKIT_OPENAI_API",
] as const;
const saved = Object.fromEntries(
  VARIABLES.map((name) => [name, process.env[name]]),
);
let endpoint: OpenAICompatibleEndpoint | undefined;
let packageModel: RuntimeModel;

beforeAll(async () => {
  packageModel = (
    await loadTenantPackage(
      new URL("../../examples/fintech", import.meta.url).pathname,
    )
  ).model;
});

afterEach(async () => {
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await endpoint?.stop();
  endpoint = undefined;
});

/** Both package Bots built as the server builds them, against a fresh endpoint. */
async function botsAgainstEndpoint() {
  endpoint = startOpenAICompatibleEndpoint();
  for (const name of VARIABLES) delete process.env[name];
  process.env.OPENAI_BASE_URL = endpoint.baseUrl;
  normalizeModelBaseUrls();
  const model = runtimeModelForEnvironment(packageModel);
  chooseOpenAIApi(model);
  // The package's own two, registered from their rows as the server registers them.
  const pkg = await loadTenantPackage(
    new URL("../../examples/fintech", import.meta.url).pathname,
  );
  const registered = pkg.agents
    .filter((agent) => agent.id === ASKER || agent.id === KNOWLEDGE)
    .map((agent) => registeredAgentFromRow(agent))
    .filter((agent) => agent !== null);
  expect(registered.map((agent) => agent.name)).toEqual([
    "General Assistant",
    "Knowledge",
  ]);
  return resolveRuntimeAgents(
    async () => registered,
    model,
    async () => "synthetic-model-key",
  );
}

/** Run one Bot's turn over this conversation and return what its model was sent. */
async function sentFor(botId: string, messages: Message[]) {
  const agents = await botsAgainstEndpoint();
  const agent = agents[botId]?.clone();
  if (!agent) throw new Error(`no ${botId} was built`);
  agent.setMessages(messages);
  await agent.runAgent({});
  const sent = endpoint?.conversations[0];
  if (!Array.isArray(sent)) throw new Error("the model was sent nothing");
  return sent as Record<string, unknown>[];
}

/** The text of one item of a Responses API `input`, whatever shape its content takes. */
function textOf(item: Record<string, unknown>): string {
  const { content } = item;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { text?: unknown }) =>
      typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

const said = (sent: Record<string, unknown>[], role: string) =>
  sent.filter((item) => item.role === role).map(textOf);

/** General Assistant's conversation as its thread holds it after a hop, with the answer in it. */
function afterAHop(): Message[] {
  return [
    { id: "person-1", role: "user", content: ASKED },
    {
      id: "asking-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_handoff",
          type: "function",
          function: {
            name: "message_bot",
            arguments: JSON.stringify({
              bot: "Knowledge",
              task: "Say in one sentence what Helm is.",
            }),
          },
        },
      ],
    },
    {
      id: "result-1",
      role: "tool",
      toolCallId: "call_handoff",
      content:
        "Handed to Knowledge. It has not replied yet: its answer arrives later as a separate message in this conversation.",
    },
    {
      id: "asking-2",
      role: "assistant",
      content: "I asked Knowledge for one sentence on what Helm is.",
    },
    {
      id: answerMessageId(KNOWLEDGE, "run-delivered"),
      role: "assistant",
      content: KNOWLEDGE_ANSWER,
    },
    { id: "person-2", role: "user", content: QUOTE },
  ];
}

describe("another Bot's answer, as the asking Bot's model reads it", () => {
  test("is Knowledge's words, not General Assistant's own turn", async () => {
    const sent = await sentFor(ASKER, afterAHop());

    // Never one of its own turns: that is how it came to claim the sentence.
    expect(
      said(sent, "assistant").filter((text) => text.includes(KNOWLEDGE_ANSWER)),
    ).toEqual([]);
    // Said to be Knowledge's, by name, word for word.
    const answer = said(sent, "user").find((text) =>
      text.includes(KNOWLEDGE_ANSWER),
    );
    expect(answer).toContain("Knowledge, another Bot, answered");
    expect(answer).toContain("You did not write this answer");
    // Inside the envelope outside content arrives in, so it carries no instruction of the person's.
    expect(answer).toContain('<untrusted_data source="Knowledge\'s answer">');
    // And the question after it is still the last thing the person said.
    expect(said(sent, "user").at(-1)).toBe(QUOTE);
    // The hop itself is still a call with its result.
    const calls = sent.filter((item) => item.type === "function_call");
    const results = sent.filter((item) => item.type === "function_call_output");
    expect(calls.map((item) => item.call_id)).toEqual(["call_handoff"]);
    expect(results.map((item) => item.call_id)).toEqual(["call_handoff"]);
  });

  test("an answer that landed while a call was open does not part the call from its result", async () => {
    /*
     * The run that asked went on to a tool that waits for the person's approval, which ends the run
     * and frees the conversation, so the answer lands between that call and its result. A user turn
     * there is where the model API stops looking for the result.
     */
    const messages = afterAHop().slice(0, 4);
    messages.push(
      {
        id: "asking-3",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_send",
            type: "function",
            function: { name: "send_summary", arguments: "{}" },
          },
        ],
      },
      {
        id: answerMessageId(KNOWLEDGE, "run-delivered"),
        role: "assistant",
        content: KNOWLEDGE_ANSWER,
      },
      {
        id: "result-3",
        role: "tool",
        toolCallId: "call_send",
        content: "Sent.",
      },
      { id: "person-2", role: "user", content: QUOTE },
    );

    const sent = await sentFor(ASKER, messages);

    const at = (predicate: (item: Record<string, unknown>) => boolean) =>
      sent.findIndex(predicate);
    const call = at(
      (item) => item.type === "function_call" && item.call_id === "call_send",
    );
    const result = at(
      (item) =>
        item.type === "function_call_output" && item.call_id === "call_send",
    );
    const answer = at(
      (item) => item.role === "user" && textOf(item).includes(KNOWLEDGE_ANSWER),
    );
    expect(call).toBeGreaterThan(-1);
    expect(result).toBe(call + 1);
    // Moved back to before the call it landed inside, still after the hop that asked for it.
    expect(answer).toBeGreaterThan(-1);
    expect(answer).toBeLessThan(call);
    expect(answer).toBeGreaterThan(
      at(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "call_handoff",
      ),
    );
  });
});

describe("a Bot addressed by its own name", () => {
  test("Knowledge is told it is the Knowledge Bot, and to answer a request for it itself", async () => {
    const sent = await sentFor(KNOWLEDGE, [
      {
        id: "person-1",
        role: "user",
        content:
          "Please remember that my team deploys with Argo CD. Then ask the Knowledge Bot for one sentence on what Helm is.",
      },
    ]);

    const instructions = [...said(sent, "system"), ...said(sent, "developer")];
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toStartWith(
      "<identity>\nYou are Knowledge, a Bot in OpenBot.",
    );
    expect(instructions[0]).toContain(
      'People call you "Knowledge" or "the Knowledge Bot".',
    );
    expect(instructions[0]).toContain(
      "A request to ask, message or hand work to Knowledge is a request to you, so answer it yourself.",
    );
  });
});
