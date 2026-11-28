/**
 * A model provider on 127.0.0.1 that speaks each provider's real streaming wire format, records
 * every request body, and answers what a test scripts.
 *
 * The formats follow shared/harness_contract.py's `fake_provider` (which the Python harnesses are
 * tested against) and the providers' own documentation, with tool calls added:
 *  - OpenAI Chat Completions: `chat.completion.chunk` SSE, a call's id and name in its first delta
 *    and its arguments in later ones, `data: [DONE]`.
 *  - OpenAI Responses: `response.*` SSE events, a `function_call` output item.
 *  - Anthropic Messages: `message_start` ... `message_stop`, `tool_use` blocks with `input_json_delta`.
 *  - Gemini: `:streamGenerateContent?alt=sse`, `functionCall` parts.
 * An error answer is the status and the provider's own error body. A Gemini model, on either of
 * Google's wires, is held to Gemini's thought-signature rule and to the models Google has retired,
 * and refused as Google refuses (`geminiRefusal`).
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type Call = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Gemini's `thoughtSignature` on the call's part. */
  signature?: string;
};
export type Turn =
  | { text?: string; calls?: Call[]; stop?: string }
  | { status: number; body: unknown };
export type Recorded = {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  /** Gemini's refusal of the request, where the thought-signature rule refused it. */
  refused?: unknown;
};
export type Responder = (request: Recorded, index: number) => Turn;

export type FakeProvider = {
  base: string;
  requests: Recorded[];
  close: () => Promise<void>;
};

function sse(response: ServerResponse, frames: string[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const frame of frames) response.write(frame);
  response.end();
}

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const named = (name: string, value: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;

function chatCompletions(
  response: ServerResponse,
  body: Record<string, unknown>,
  turn: { text?: string; calls?: Call[] },
) {
  const model = String(body.model ?? "model");
  const base = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model,
  };
  const frames: string[] = [];
  frames.push(
    data({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    }),
  );
  if (turn.text) {
    for (const piece of turn.text.match(/.{1,8}/gs) ?? []) {
      frames.push(
        data({
          ...base,
          choices: [
            { index: 0, delta: { content: piece }, finish_reason: null },
          ],
        }),
      );
    }
  }
  const calls = turn.calls ?? [];
  // Every call's head first, then their arguments interleaved: the parallel shape that broke one
  // tool slot in the Python integration.
  for (const [index, call] of calls.entries()) {
    frames.push(
      data({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: "" },
                  // Gemini's OpenAI-compatible API: the thought signature on the call's delta.
                  ...(call.signature
                    ? {
                        extra_content: {
                          google: { thought_signature: call.signature },
                        },
                      }
                    : {}),
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }
  const pieces = calls.map(
    (call) => JSON.stringify(call.args).match(/.{1,5}/gs) ?? [],
  );
  for (
    let round = 0;
    round < Math.max(0, ...pieces.map((p) => p.length));
    round += 1
  ) {
    for (const [index, parts] of pieces.entries()) {
      if (parts[round] !== undefined)
        frames.push(
          data({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index, function: { arguments: parts[round] } },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
    }
  }
  frames.push(
    data({
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: calls.length ? "tool_calls" : "stop",
        },
      ],
    }),
  );
  frames.push(
    data({
      ...base,
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  );
  frames.push("data: [DONE]\n\n");
  sse(response, frames);
}

function responses(
  response: ServerResponse,
  body: Record<string, unknown>,
  turn: { text?: string; calls?: Call[] },
) {
  const model = String(body.model ?? "model");
  const output: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const shell = {
    id: "resp_fake",
    object: "response",
    created_at: 0,
    model,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
  events.push({
    type: "response.created",
    response: { ...shell, status: "in_progress", output: [] },
  });
  if (turn.text) {
    const item = {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: turn.text, annotations: [] }],
    };
    const index = output.length;
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, status: "in_progress", content: [] },
    });
    events.push({
      type: "response.content_part.added",
      output_index: index,
      item_id: "msg_fake",
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    events.push({
      type: "response.output_text.delta",
      output_index: index,
      item_id: "msg_fake",
      content_index: 0,
      delta: turn.text,
    });
    events.push({
      type: "response.output_text.done",
      output_index: index,
      item_id: "msg_fake",
      content_index: 0,
      text: turn.text,
    });
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
    output.push(item);
  }
  for (const call of turn.calls ?? []) {
    const index = output.length;
    const id = `fc_${call.id}`;
    const args = JSON.stringify(call.args);
    const item = {
      id,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: args,
    };
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, status: "in_progress", arguments: "" },
    });
    events.push({
      type: "response.function_call_arguments.delta",
      output_index: index,
      item_id: id,
      delta: args,
    });
    events.push({
      type: "response.function_call_arguments.done",
      output_index: index,
      item_id: id,
      arguments: args,
    });
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
    output.push(item);
  }
  events.push({
    type: "response.completed",
    response: {
      ...shell,
      status: "completed",
      output,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
  });
  sse(
    response,
    events.map((event, index) =>
      named(String(event.type), { ...event, sequence_number: index }),
    ),
  );
}

function anthropic(
  response: ServerResponse,
  body: Record<string, unknown>,
  turn: { text?: string; calls?: Call[]; stop?: string },
) {
  const message = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: String(body.model ?? "claude"),
    stop_sequence: null,
  };
  const frames: string[] = [];
  frames.push(
    named("message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
  );
  let index = 0;
  if (turn.text) {
    frames.push(
      named("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
    );
    for (const piece of turn.text.match(/.{1,8}/gs) ?? [])
      frames.push(
        named("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        }),
      );
    frames.push(
      named("content_block_stop", { type: "content_block_stop", index }),
    );
    index += 1;
  }
  for (const call of turn.calls ?? []) {
    frames.push(
      named("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
        },
      }),
    );
    for (const piece of JSON.stringify(call.args).match(/.{1,6}/gs) ?? [])
      frames.push(
        named("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: piece },
        }),
      );
    frames.push(
      named("content_block_stop", { type: "content_block_stop", index }),
    );
    index += 1;
  }
  const stop = turn.stop ?? (turn.calls?.length ? "tool_use" : "end_turn");
  frames.push(
    named("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
  );
  frames.push(named("message_stop", { type: "message_stop" }));
  sse(response, frames);
}

function gemini(
  response: ServerResponse,
  turn: { text?: string; calls?: Call[]; stop?: string },
) {
  const frames: string[] = [];
  if (turn.text) {
    for (const piece of turn.text.match(/.{1,8}/gs) ?? [])
      frames.push(
        data({
          candidates: [
            { content: { role: "model", parts: [{ text: piece }] }, index: 0 },
          ],
          modelVersion: "gemini-fake",
        }),
      );
  }
  if (turn.calls?.length) {
    frames.push(
      data({
        candidates: [
          {
            content: {
              role: "model",
              // Gemini 2.5 sends no call id; Gemini 3 sends one. Both may carry a thought signature,
              // which must come back with the call on the next request.
              parts: turn.calls.map((call) => ({
                functionCall: {
                  ...(call.id ? { id: call.id } : {}),
                  name: call.name,
                  args: call.args,
                },
                ...(call.signature ? { thoughtSignature: call.signature } : {}),
              })),
            },
            index: 0,
          },
        ],
        modelVersion: "gemini-fake",
      }),
    );
  }
  frames.push(
    data({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          finishReason: turn.stop ?? "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
      modelVersion: "gemini-fake",
    }),
  );
  sse(response, frames);
}

/*
 * GEMINI'S THOUGHT-SIGNATURE RULE, as the real API enforces it on Gemini 3 and later
 * (https://ai.google.dev/gemini-api/docs/thought-signatures), on both of Google's wires:
 *  - The current turn is everything after the latest user message with text in it (a function
 *    response is not one). Earlier turns are not checked.
 *  - The first function call of each model step in the current turn must carry the signature
 *    Gemini gave it: natively the part's `thoughtSignature`, on the OpenAI-compatible API the tool
 *    call's `extra_content.google.thought_signature`. Missing: 400, in Google's words. One Gemini
 *    never gave: 400. Google's two documented placeholders for calls it did not make pass.
 *  - Gemini 1 and 2 check nothing.
 * The error body is Google's as its OpenAI-compatible API sends it: a JSON array of one error.
 */
const GEMINI_PLACEHOLDERS = new Set([
  "skip_thought_signature_validator",
  "context_engineering_is_the_way_to_go",
]);

function checksSignatures(model: string): boolean {
  return (
    /^(models\/)?gemini-/i.test(model) && !/gemini-[12](\.|-)/i.test(model)
  );
}

export type Issued = { byId: Map<string, string>; all: Set<string> };

const googleError = (message: string) => [
  { error: { code: 400, message, status: "INVALID_ARGUMENT" } },
];

function missing(name: string, position: number) {
  return googleError(
    `Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call \`default_api:${name}\` , position ${position}. Please refer to https://aistudio.google.com/docs/thought-signatures for more details.`,
  );
}

const INVALID = googleError("Thought signature is not valid.");

/** One step's first call, as either wire sends it back. */
type Step = {
  position: number;
  name: string;
  id?: string;
  signature?: string;
};

function checkSteps(steps: Step[], issued: Issued): unknown | undefined {
  for (const step of steps) {
    if (!step.signature) return missing(step.name, step.position);
    if (GEMINI_PLACEHOLDERS.has(step.signature)) continue;
    const given = step.id ? issued.byId.get(step.id) : undefined;
    if (given ? given !== step.signature : !issued.all.has(step.signature))
      return INVALID;
  }
  return undefined;
}

/** The OpenAI-compatible request's current-turn steps. */
function chatSteps(body: Record<string, unknown>): Step[] {
  const contents = ((body.messages ?? []) as Record<string, unknown>[]).filter(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  const start = contents.findLastIndex((message) => message.role === "user");
  const steps: Step[] = [];
  for (const [position, message] of contents.entries()) {
    if (position <= start || message.role !== "assistant") continue;
    const first = (
      message.tool_calls as
        | {
            id?: string;
            function?: { name?: string };
            extra_content?: { google?: { thought_signature?: string } };
          }[]
        | undefined
    )?.[0];
    if (!first) continue;
    steps.push({
      position,
      name: String(first.function?.name ?? ""),
      id: first.id,
      signature: first.extra_content?.google?.thought_signature,
    });
  }
  return steps;
}

/** The native request's current-turn steps. */
function nativeSteps(body: Record<string, unknown>): Step[] {
  const contents = (body.contents ?? []) as {
    role?: string;
    parts?: Record<string, unknown>[];
  }[];
  const start = contents.findLastIndex(
    (content) =>
      content.role === "user" &&
      (content.parts ?? []).some(
        (part) => typeof part.text === "string" && part.text,
      ),
  );
  const steps: Step[] = [];
  for (const [position, content] of contents.entries()) {
    if (position <= start || content.role !== "model") continue;
    const first = (content.parts ?? []).find((part) => "functionCall" in part);
    if (!first) continue;
    const call = first.functionCall as { id?: string; name?: string };
    steps.push({
      position,
      name: String(call.name ?? ""),
      id: call.id,
      signature:
        typeof first.thoughtSignature === "string"
          ? first.thoughtSignature
          : undefined,
    });
  }
  return steps;
}

/**
 * Models Google no longer serves to new keys, with its 404 as both wires send it (seen live on
 * 2026-11-27: "This model models/gemini-2.5-flash is no longer available to new users").
 */
const RETIRED_GEMINI = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);

function retired(model: string, wire: "chat" | "native") {
  const error = {
    error: {
      code: 404,
      message: `This model models/${model} is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements. We recommend you to use the Interactions API (https://aistudio.google.com/docs/get-started).`,
      status: "NOT_FOUND",
    },
  };
  return { status: 404, body: wire === "chat" ? [error] : error };
}

/** Gemini's refusal of this request, or undefined where Gemini would take it. */
function geminiRefusal(
  recorded: Recorded,
  issued: Issued,
): { status: number; body: unknown } | undefined {
  const path = recorded.path;
  const refusedBy = (body: unknown) =>
    body === undefined ? undefined : { status: 400, body };
  if (path.endsWith("/chat/completions")) {
    const model = String(recorded.body.model ?? "");
    if (RETIRED_GEMINI.has(model)) return retired(model, "chat");
    if (!checksSignatures(model)) return undefined;
    return refusedBy(checkSteps(chatSteps(recorded.body), issued));
  }
  const native = /\/models\/([^/:]+):streamGenerateContent/.exec(path);
  if (native) {
    const model = native[1] ?? "";
    if (RETIRED_GEMINI.has(model)) return retired(model, "native");
    if (!checksSignatures(model)) return undefined;
    return refusedBy(checkSteps(nativeSteps(recorded.body), issued));
  }
  return undefined;
}

export async function fakeProvider(respond: Responder): Promise<FakeProvider> {
  const requests: Recorded[] = [];
  const issued: Issued = { byId: new Map(), all: new Set() };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = request.url ?? "/";
    const recorded: Recorded = {
      path,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : {},
    };
    requests.push(recorded);
    const refused = geminiRefusal(recorded, issued);
    if (refused) {
      recorded.refused = refused.body;
      response.writeHead(refused.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(refused.body));
      return;
    }
    const turn = respond(recorded, requests.length - 1);
    if ("status" in turn) {
      response.writeHead(turn.status, { "content-type": "application/json" });
      response.end(JSON.stringify(turn.body));
      return;
    }
    for (const call of turn.calls ?? []) {
      if (!call.signature) continue;
      issued.all.add(call.signature);
      if (call.id) issued.byId.set(call.id, call.signature);
    }
    if (path.endsWith("/chat/completions"))
      return chatCompletions(response, recorded.body, turn);
    if (path.endsWith("/responses"))
      return responses(response, recorded.body, turn);
    if (path.endsWith("/messages"))
      return anthropic(response, recorded.body, turn);
    if (path.includes(":streamGenerateContent")) return gemini(response, turn);
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `no route ${path}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Always the same answer. */
export const always =
  (turn: Turn): Responder =>
  () =>
    turn;
