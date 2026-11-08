/**
 * The model local Intelligence's Learning agent thinks with when the person signed in to a Claude or
 * ChatGPT plan rather than giving OpenBot an API key.
 *
 * A plan has no key to hand over. The Bots answer on it through the plan's own harness, which holds
 * the sign-in and renews it (`agents/plan-model.ts`), and Learning is answered the same way: this is
 * an OpenAI Chat Completions endpoint, the default wire the Learning agent speaks to a compatible
 * endpoint (`LEARNING_AGENT_MODEL_BASE_URL`, Intelligence `libs/learning-agent/src/model.ts`), and
 * each call it receives is one model-only step on that harness. The harness reads the plan's current
 * sign-in on every step, so a renewed token is used on the next call without anything restarting.
 *
 * ONLY LEARNING MAY SPEND THE PLAN HERE. OpenBot Desktop mints one secret per installation, hands it
 * to the server and to the Learning agent's key (`LEARNING_AGENT_MODEL_API_KEY`), and to nothing
 * else. A call without it is refused before anything else is read. The server's port is published on
 * this machine's loopback alone, and the local cluster reaches it through the host name its engine
 * gives the machine.
 */
import type { Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sameToken } from "../agents/callback-token";
import { PlanModel, type PlanModelConfig } from "../agents/plan-model";

export const LEARNING_MODEL_ROUTE = "/api/learning-model/v1/chat/completions";

/** A Learning phase sends its whole corpus each step. Bounded, but well above any phase. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

type CallOptions = Parameters<PlanModel["doStream"]>[0];
type Prompt = CallOptions["prompt"];
type Part =
  Awaited<ReturnType<PlanModel["doStream"]>>["stream"] extends ReadableStream<
    infer T
  >
    ? T
    : never;

export type LearningModelEndpoint = {
  plan: PlanModelConfig;
  /** The per-installation secret the Learning agent sends as its key. */
  token: string;
  /** What became of each call, so a failed run can say why (`review.ts` `runFailure`). */
  calls?: LearningModelCalls;
};

/** The endpoint, when this deployment answers on a plan and Desktop minted Learning's secret. */
export function learningModelEndpointFor(
  plan: PlanModelConfig | undefined,
  token: string | undefined,
  calls?: LearningModelCalls,
): LearningModelEndpoint | undefined {
  const secret = token?.trim();
  return plan && secret
    ? { plan, token: secret, ...(calls ? { calls } : {}) }
    : undefined;
}

/**
 * What became of one call to the endpoint. Intelligence keeps only a code for a failed run, never the
 * agent's own error, so this is how Settings can tell a Learning agent that never reached OpenBot from
 * a plan that needs signing in again.
 */
export type LearningModelCallOutcome =
  | "answered"
  | "sign-in"
  | "unanswered"
  | "refused";

export type LearningModelCalls = {
  record: (outcome: LearningModelCallOutcome) => void;
  /** The outcomes recorded between two instants, in milliseconds since the epoch. */
  between: (from: number, to: number) => LearningModelCallOutcome[];
};

/** This server's record of the endpoint's recent calls, in memory: a restart starts it again. */
export function createLearningModelCalls(
  now: () => number = Date.now,
): LearningModelCalls {
  const kept: { at: number; outcome: LearningModelCallOutcome }[] = [];
  return {
    record: (outcome) => {
      kept.push({ at: now(), outcome });
      if (kept.length > 500) kept.splice(0, kept.length - 500);
    },
    between: (from, to) =>
      kept
        .filter((call) => call.at >= from && call.at <= to)
        .map((call) => call.outcome),
  };
}

const text = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);

const userContent = z.union([
  z.string(),
  z.array(
    z.union([
      z.looseObject({ type: z.literal("text"), text: z.string() }),
      z.looseObject({
        type: z.literal("image_url"),
        image_url: z.looseObject({ url: z.string() }),
      }),
    ]),
  ),
]);

const toolCall = z.looseObject({
  id: z.string().min(1),
  type: z.literal("function").optional(),
  function: z.looseObject({ name: z.string().min(1), arguments: z.string() }),
});

const message = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("system"), content: text }),
  z.looseObject({ role: z.literal("developer"), content: text }),
  z.looseObject({ role: z.literal("user"), content: userContent }),
  z.looseObject({
    role: z.literal("assistant"),
    content: text.nullish(),
    tool_calls: z.array(toolCall).nullish(),
  }),
  z.looseObject({
    role: z.literal("tool"),
    tool_call_id: z.string().min(1),
    content: text,
  }),
]);

const request = z.looseObject({
  model: z.string().default("plan"),
  messages: z.array(message).min(1),
  tools: z
    .array(
      z.looseObject({
        type: z.literal("function"),
        function: z.looseObject({
          name: z.string().min(1),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z.unknown().optional(),
  stream: z.boolean().optional(),
});

type ChatRequest = z.infer<typeof request>;

function joined(content: z.infer<typeof text> | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.text ?? "").join("");
}

/** A tool call's arguments as the model wrote them, as the object the plan harness is given. */
function parsedArguments(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

/** Chat Completions messages, as the AI SDK prompt the plan's model takes. */
export function promptFor(messages: ChatRequest["messages"]): Prompt {
  const prompt: Prompt = [];
  const toolNames = new Map<string, string>();
  for (const entry of messages) {
    switch (entry.role) {
      case "system":
      case "developer":
        prompt.push({ role: "system", content: joined(entry.content) });
        break;
      case "user":
        prompt.push({
          role: "user",
          content:
            typeof entry.content === "string"
              ? [{ type: "text", text: entry.content }]
              : entry.content.map((part) => {
                  if (part.type === "text")
                    return { type: "text" as const, text: part.text };
                  const url = part.image_url.url;
                  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
                  return inline
                    ? {
                        type: "file" as const,
                        mediaType: inline[1] ?? "image/png",
                        data: inline[2] ?? "",
                      }
                    : {
                        type: "file" as const,
                        mediaType: "image/*",
                        data: new URL(url),
                      };
                }),
        });
        break;
      case "assistant": {
        const content: Extract<
          Prompt[number],
          { role: "assistant" }
        >["content"] = [];
        const said = joined(entry.content);
        if (said) content.push({ type: "text", text: said });
        for (const call of entry.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name);
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input: parsedArguments(call.function.arguments),
          });
        }
        prompt.push({ role: "assistant", content });
        break;
      }
      case "tool":
        prompt.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: entry.tool_call_id,
              toolName: toolNames.get(entry.tool_call_id) ?? "tool",
              output: { type: "text", value: joined(entry.content) },
            },
          ],
        });
        break;
    }
  }
  return prompt;
}

function refused(status: 400 | 401 | 502, error: string): Response {
  return Response.json(
    { error: { message: error, type: "openbot_learning_model" } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Why the plan's harness could not answer, in words the Learning run records. */
function failureOf(
  error: unknown,
  record: (outcome: LearningModelCallOutcome) => void,
): Response {
  const signIn =
    error instanceof Error && error.name === "OpenBotModelAuthenticationError";
  record(signIn ? "sign-in" : "unanswered");
  if (signIn)
    return refused(
      401,
      "The model plan OpenBot is signed in to needs signing in again.",
    );
  return refused(502, "The model plan OpenBot is signed in to didn't answer.");
}

type Completion = {
  id: string;
  created: number;
  model: string;
};

function chunk(
  completion: Completion,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/**
 * Answer one Chat Completions call on the plan's harness: streamed as `chat.completion.chunk` events
 * when the caller asked to stream, which the Learning agent always does, and as one
 * `chat.completion` otherwise.
 */
export function createLearningModelHandler(
  endpoint: LearningModelEndpoint,
): (request: Request) => Promise<Response> {
  const record = endpoint.calls?.record ?? (() => {});
  return async (incoming) => {
    const offered = incoming.headers.get("authorization") ?? "";
    if (!sameToken(offered, `Bearer ${endpoint.token}`)) {
      record("refused");
      return refused(401, "This endpoint answers OpenBot's Learning only.");
    }

    let body: ChatRequest;
    try {
      body = request.parse(await incoming.json());
    } catch {
      return refused(400, "The model request could not be read.");
    }

    // A conversation of its own each call, so no step is ever a turn in somebody's thread, and the
    // plan's query is let go once it has answered (`routing/model.ts` `askPlan` does the same).
    const controller = new AbortController();
    const stop = () => controller.abort();
    incoming.signal.addEventListener("abort", stop, { once: true });
    const finish = () => {
      incoming.signal.removeEventListener("abort", stop);
      controller.abort();
    };

    const model = new PlanModel(
      endpoint.plan,
      "openbot-learning",
      { threadId: crypto.randomUUID() },
      new Set(),
      controller.signal,
    );
    const options: CallOptions = {
      prompt: promptFor(body.messages),
      abortSignal: controller.signal,
      ...(body.tools?.length
        ? {
            tools: body.tools.map((tool) => ({
              type: "function" as const,
              name: tool.function.name,
              ...(tool.function.description
                ? { description: tool.function.description }
                : {}),
              inputSchema: (tool.function.parameters ?? {
                type: "object",
                properties: {},
              }) as Extract<
                NonNullable<CallOptions["tools"]>[number],
                { type: "function" }
              >["inputSchema"],
            })),
          }
        : {}),
      ...(body.tool_choice === "none"
        ? { toolChoice: { type: "none" as const } }
        : {}),
    };

    let reader: ReadableStreamDefaultReader<Part>;
    // The first part that says something, read before any status is sent, so a plan that refuses
    // the step is answered with an error status rather than a stream that breaks off.
    let first: Part | undefined;
    try {
      reader = (await model.doStream(options)).stream.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.type !== "stream-start") {
          first = next.value;
          break;
        }
      }
    } catch (error) {
      finish();
      return failureOf(error, record);
    }

    const completion: Completion = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    const parts = async function* (): AsyncGenerator<Part> {
      if (first) yield first;
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    };

    if (!body.stream) {
      let said = "";
      const calls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[] = [];
      let finishReason = "stop";
      try {
        for await (const part of parts()) {
          if (part.type === "text-delta") said += part.delta;
          if (part.type === "tool-call")
            calls.push({
              id: part.toolCallId,
              type: "function",
              function: { name: part.toolName, arguments: part.input },
            });
          if (part.type === "finish")
            finishReason =
              part.finishReason.unified === "tool-calls"
                ? "tool_calls"
                : "stop";
        }
      } catch (error) {
        return failureOf(error, record);
      } finally {
        finish();
      }
      record("answered");
      return Response.json(
        {
          ...completion,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: said || null,
                ...(calls.length ? { tool_calls: calls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(sink) {
        const send = (line: string) => sink.enqueue(encoder.encode(line));
        const calls = new Map<string, number>();
        try {
          send(chunk(completion, { role: "assistant", content: "" }));
          for await (const part of parts()) {
            switch (part.type) {
              case "text-delta":
                if (part.delta)
                  send(chunk(completion, { content: part.delta }));
                break;
              case "tool-input-start": {
                const index = calls.size;
                calls.set(part.id, index);
                send(
                  chunk(completion, {
                    tool_calls: [
                      {
                        index,
                        id: part.id,
                        type: "function",
                        function: { name: part.toolName, arguments: "" },
                      },
                    ],
                  }),
                );
                break;
              }
              case "tool-input-delta":
                send(
                  chunk(completion, {
                    tool_calls: [
                      {
                        index: calls.get(part.id) ?? 0,
                        function: { arguments: part.delta },
                      },
                    ],
                  }),
                );
                break;
              case "finish":
                send(
                  chunk(
                    completion,
                    {},
                    part.finishReason.unified === "tool-calls"
                      ? "tool_calls"
                      : "stop",
                  ),
                );
                break;
            }
          }
          send("data: [DONE]\n\n");
          record("answered");
        } catch (error) {
          // The OpenAI client the Learning agent runs on raises an `error` event as the call's error.
          const answer = (await failureOf(error, record).json()) as unknown;
          send(`data: ${JSON.stringify(answer)}\n\n`);
        } finally {
          finish();
          sink.close();
        }
      },
      cancel() {
        finish();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  };
}

/** Mounted only on a deployment that answers on a plan and has Learning's secret. */
export function mountLearningModelEndpoint<T extends Env>(
  app: Hono<T>,
  endpoint: LearningModelEndpoint | undefined,
): void {
  if (!endpoint) return;
  const handle = createLearningModelHandler(endpoint);
  app.post(
    LEARNING_MODEL_ROUTE,
    bodyLimit({ maxSize: MAX_REQUEST_BYTES }),
    (context) => handle(context.req.raw),
  );
}
