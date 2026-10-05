import { randomUUID } from "node:crypto";
import { z } from "zod";

// Google's OpenAI endpoint accepts API keys, not the desktop's user OAuth token.
// Keep the local agents' Chat Completions contract while using the native API.
const toolCall = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const chat = z.object({
  model: z.string().regex(/^(?:models\/)?[a-zA-Z0-9._-]+$/),
  messages: z.array(
    z.object({
      role: z.enum(["system", "developer", "user", "assistant", "tool"]),
      content: z.unknown().optional(),
      tool_calls: z.array(toolCall).optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
  stream: z.boolean().optional(),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  response_format: z
    .object({
      type: z.string(),
      json_schema: z
        .object({ schema: z.record(z.string(), z.unknown()) })
        .optional(),
    })
    .optional(),
});
const partSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        id: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
type Part = z.infer<typeof partSchema>;
type Content = { role: "user" | "model"; parts: Part[] };
const nativeResponse = z.object({
  candidates: z
    .array(
      z.object({
        index: z.number().optional(),
        content: z.object({ parts: z.array(partSchema).optional() }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});
type NativeResponse = z.infer<typeof nativeResponse>;

function parseNative(value: unknown): NativeResponse {
  if (value && typeof value === "object" && "error" in value)
    throw new Error("The Google model stream failed.");
  return nativeResponse.parse(value);
}

function contentParts(value: unknown): Part[] {
  if (value == null) return [];
  if (typeof value === "string") return value ? [{ text: value }] : [];
  return z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.object({ url: z.string() }).optional(),
      }),
    )
    .parse(value)
    .map((part) => {
      if (part.type === "text" && part.text !== undefined)
        return { text: part.text };
      if (part.type === "image_url" && part.image_url) {
        const data =
          /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(
            part.image_url.url,
          );
        if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
        const url = new URL(part.image_url.url);
        if (url.protocol !== "https:") throw new Error("Unsupported image URL");
        return { fileData: { fileUri: url.href } };
      }
      throw new Error("Unsupported model content");
    });
}

// Match LiteLLM's maintained OpenAI-client compatibility technique: only the
// opaque signature travels in the ID, never model text or tool arguments.
// https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/prompt_templates/factory.py
const signatureSeparator = "__thought__";

export function googleRequest(input: unknown) {
  const request = chat.parse(input);
  const contents: Content[] = [];
  const system: Part[] = [];
  const calls = new Map<string, { name: string; id?: string }>();
  for (const message of request.messages) {
    let parts = contentParts(message.content);
    if (message.role === "system" || message.role === "developer") {
      if (parts.some((part) => part.text === undefined))
        throw new Error("System instructions must be text");
      system.push(...parts);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const generated = message.tool_calls.map((call) => {
        const args = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(call.function.arguments));
        const separator = call.id.indexOf(signatureSeparator);
        const cleanId = separator < 0 ? call.id : call.id.slice(0, separator);
        const signature =
          separator < 0
            ? undefined
            : call.id.slice(separator + signatureSeparator.length);
        const id = /^(?:models\/)?gemini-3/.test(request.model)
          ? cleanId
          : undefined;
        calls.set(call.id, { name: call.function.name, id });
        return {
          functionCall: {
            name: call.function.name,
            args,
            ...(id ? { id } : {}),
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        };
      });
      parts.push(...generated);
    }
    if (message.role === "tool") {
      const call = calls.get(message.tool_call_id ?? "");
      if (!call) throw new Error("Tool result has no matching call");
      const text = parts
        .flatMap((part) => (part.text === undefined ? [] : [part.text]))
        .join("\n");
      const images = parts.filter((part) => part.inlineData !== undefined);
      if (parts.some((part) => part.fileData !== undefined))
        throw new Error("Tool images must use inline data");
      let result: unknown = text;
      try {
        result = JSON.parse(text);
      } catch {
        /* Plain text tool output is valid. */
      }
      parts = [
        {
          functionResponse: {
            ...call,
            response: { result },
            ...(images.length ? { parts: images } : {}),
          },
        },
      ];
    }
    if (!parts.length) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const generationConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined)
    generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) generationConfig.topP = request.top_p;
  if (
    request.max_completion_tokens !== undefined ||
    request.max_tokens !== undefined
  )
    generationConfig.maxOutputTokens =
      request.max_completion_tokens ?? request.max_tokens;
  if (request.stop)
    generationConfig.stopSequences =
      typeof request.stop === "string" ? [request.stop] : request.stop;
  if (
    request.response_format?.type === "json_object" ||
    request.response_format?.type === "json_schema"
  ) {
    generationConfig.responseMimeType = "application/json";
    if (request.response_format.json_schema)
      generationConfig.responseJsonSchema =
        request.response_format.json_schema.schema;
  }
  const choice = request.tool_choice;
  const model = request.model.replace(/^models\//, "");
  return {
    model,
    stream: request.stream === true,
    includeUsage: request.stream_options?.include_usage === true,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:${request.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    body: {
      contents,
      ...(system.length ? { systemInstruction: { parts: system } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map(({ function: fn }) => ({
                  name: fn.name,
                  ...(fn.description ? { description: fn.description } : {}),
                  ...(fn.parameters
                    ? { parametersJsonSchema: fn.parameters }
                    : {}),
                })),
              },
            ],
          }
        : {}),
      ...(choice
        ? {
            toolConfig: {
              functionCallingConfig:
                typeof choice === "object"
                  ? {
                      mode: "ANY",
                      allowedFunctionNames: [choice.function.name],
                    }
                  : {
                      mode: { auto: "AUTO", none: "NONE", required: "ANY" }[
                        choice
                      ],
                    },
            },
          }
        : {}),
    },
  };
}

function usage(metadata: NativeResponse["usageMetadata"]) {
  if (!metadata) return undefined;
  const prompt = metadata.promptTokenCount ?? 0;
  const completion =
    (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: metadata.totalTokenCount ?? prompt + completion,
    completion_tokens_details: {
      reasoning_tokens: metadata.thoughtsTokenCount ?? 0,
    },
  };
}

function finishReason(reason: string | undefined, hasCalls: boolean): string {
  if (reason === "MAX_TOKENS") return "length";
  if (reason && reason !== "STOP") return "content_filter";
  return hasCalls ? "tool_calls" : "stop";
}

function outputCalls(parts: Part[]) {
  return parts
    .flatMap((part) =>
      part.functionCall ? [{ part, fn: part.functionCall }] : [],
    )
    .map(({ part, fn }) => ({
      id: `${fn.id ?? `call_${randomUUID().replaceAll("-", "")}`}${part.thoughtSignature ? `${signatureSeparator}${part.thoughtSignature}` : ""}`,
      type: "function" as const,
      function: { name: fn.name, arguments: JSON.stringify(fn.args ?? {}) },
    }));
}

/** Transform only successful native responses; the caller handles auth and errors. */
export async function googleResponse(
  response: Response,
  model: string,
  stream: boolean,
  includeUsage = false,
): Promise<Response> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const headers = {
    "content-type": stream ? "text/event-stream" : "application/json",
    "cache-control": "no-store",
  };
  if (!stream) {
    const native = parseNative(await response.json());
    const candidate = native.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const calls = outputCalls(parts);
    return Response.json(
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                parts
                  .filter((part) => !part.thought)
                  .map((part) => part.text ?? "")
                  .join("") || null,
              ...(calls.length ? { tool_calls: calls } : {}),
              extra_content: { google: { parts } },
            },
            finish_reason: finishReason(
              candidate?.finishReason ?? native.promptFeedback?.blockReason,
              calls.length > 0,
            ),
          },
        ],
        usage: usage(native.usageMetadata),
      },
      { headers },
    );
  }
  if (!response.body) throw new Error("Gemini returned no stream");
  let buffer = "";
  let data: string[] = [];
  const parts: Part[] = [];
  let metadata: NativeResponse["usageMetadata"];
  let reason: string | undefined;
  let began = false;
  let failed = false;
  const encode = new TextEncoder();
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (failed) return;
    failed = true;
    controller.enqueue(
      encode.encode(
        `data: ${JSON.stringify({ error: { message: "The Google model stream failed or ended early. Try again.", type: "provider_error", code: "incomplete_model_stream" } })}\n\n`,
      ),
    );
  };
  const send = (
    controller: TransformStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) => {
    controller.enqueue(
      encode.encode(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      ),
    );
  };
  const frame = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!data.length) return;
    const json = data.join("\n");
    data = [];
    if (json === "[DONE]") return;
    let native: NativeResponse;
    try {
      native = parseNative(JSON.parse(json));
    } catch {
      fail(controller);
      return;
    }
    if (!began) {
      send(controller, { role: "assistant", content: "" });
      began = true;
    }
    const candidate = native.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      parts.push(part);
      if (part.text && !part.thought) send(controller, { content: part.text });
    }
    metadata = native.usageMetadata ?? metadata;
    reason =
      candidate?.finishReason ?? native.promptFeedback?.blockReason ?? reason;
  };
  const transformed = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          if (failed) return;
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (!line) frame(controller);
            else if (line.startsWith("data:"))
              data.push(line.slice(5).replace(/^ /, ""));
            else if (!/^(?::|event:|id:|retry:)/.test(line)) fail(controller);
            if (failed) return;
            newline = buffer.indexOf("\n");
          }
        },
        flush(controller) {
          if (failed) return;
          if (buffer.trim() || data.length || !reason) {
            fail(controller);
            return;
          }
          const calls = outputCalls(parts);
          if (calls.length)
            send(controller, {
              tool_calls: calls.map((call, index) => ({ index, ...call })),
            });
          send(controller, {}, finishReason(reason, calls.length > 0));
          if (includeUsage && metadata)
            controller.enqueue(
              encode.encode(
                `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usage(metadata) })}\n\n`,
              ),
            );
          controller.enqueue(encode.encode("data: [DONE]\n\n"));
        },
      }),
    );
  return new Response(transformed, { headers });
}
