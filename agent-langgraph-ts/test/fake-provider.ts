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
 * An error answer is the status and the provider's own error body.
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

export async function fakeProvider(respond: Responder): Promise<FakeProvider> {
  const requests: Recorded[] = [];
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
    const turn = respond(recorded, requests.length - 1);
    if ("status" in turn) {
      response.writeHead(turn.status, { "content-type": "application/json" });
      response.end(JSON.stringify(turn.body));
      return;
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
