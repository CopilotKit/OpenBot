import { expect, test } from "bun:test";
import { googleRequest, googleResponse } from "../src/google-oauth-transport";

test("native Gemini converts tools, screenshot input and signed tool results without losing parts", async () => {
  const nativeParts = [
    { text: "Looking at the page" },
    {
      functionCall: {
        name: "browser",
        args: { url: "https://example.com" },
        id: "native-1",
      },
      thoughtSignature: "opaque-signature",
    },
    {
      functionCall: { name: "chart", args: { values: [1, 2] }, id: "native-2" },
    },
  ];
  const response = await googleResponse(
    Response.json({
      candidates: [{ content: { parts: nativeParts }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 3,
        totalTokenCount: 15,
      },
    }),
    "gemini-3.6-flash",
    false,
  );
  const completion = await response.json();
  expect(completion.choices[0].finish_reason).toBe("tool_calls");
  expect(completion.usage.completion_tokens).toBe(7);
  const calls = completion.choices[0].message.tool_calls;
  // Real generic clients keep standard fields and discard provider-specific fields.
  const converted = googleRequest({
    model: "gemini-3.6-flash",
    stream: true,
    messages: [
      { role: "system", content: "Use the tools" },
      {
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aW1hZ2U=" },
          },
        ],
      },
      {
        role: "assistant",
        content: "Looking at the page",
        tool_calls: calls.map(
          (call: { id: string; type: string; function: unknown }) => ({
            id: call.id,
            type: call.type,
            function: call.function,
          }),
        ),
      },
      { role: "tool", tool_call_id: calls[0].id, content: "Page loaded" },
      {
        role: "tool",
        tool_call_id: calls[1].id,
        content: [
          { type: "text", text: "Rendered" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,c2NyZWVu" },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "browser",
          description: "Browse",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      },
    ],
    tool_choice: "required",
  });
  expect(converted.url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
  );
  expect(converted.body).toMatchObject({
    systemInstruction: { parts: [{ text: "Use the tools" }] },
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    tools: [
      {
        functionDeclarations: [
          { name: "browser", parametersJsonSchema: { type: "object" } },
        ],
      },
    ],
  });
  expect(converted.body.contents[0].parts[1]).toEqual({
    inlineData: { mimeType: "image/png", data: "aW1hZ2U=" },
  });
  expect(converted.body.contents[1].parts).toEqual(nativeParts);
  expect(converted.body.contents[2].parts).toEqual([
    {
      functionResponse: {
        name: "browser",
        id: "native-1",
        response: { result: "Page loaded" },
      },
    },
    {
      functionResponse: {
        name: "chart",
        id: "native-2",
        response: { result: "Rendered" },
        parts: [{ inlineData: { mimeType: "image/png", data: "c2NyZWVu" } }],
      },
    },
  ]);
});

test("Gemini SSE produces incremental OpenAI text, signed tool calls, usage and DONE", async () => {
  const frames = [
    { candidates: [{ content: { parts: [{ text: "Hello " }] } }] },
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "world" },
              {
                functionCall: {
                  name: "browser",
                  args: { url: "https://example.com" },
                },
                thoughtSignature: "signed",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        totalTokenCount: 5,
      },
    },
  ];
  const wire = frames
    .map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(wire);
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const response = await googleResponse(
    upstream,
    "gemini-3.6-flash",
    true,
    true,
  );
  const text = await response.text();
  const chunks = text
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  expect(
    chunks
      .flatMap((chunk) => chunk.choices)
      .map((choice) => choice.delta.content ?? "")
      .join(""),
  ).toBe("Hello world");
  const toolChunk = chunks.find((chunk) => chunk.choices[0]?.delta.tool_calls);
  expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe(
    "browser",
  );
  expect(
    chunks.some((chunk) => chunk.choices[0]?.finish_reason === "tool_calls"),
  ).toBe(true);
  expect(chunks.at(-1).usage.total_tokens).toBe(5);
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("unsupported content and unsafe model names fail before sending provider credentials", () => {
  expect(() => googleRequest({ model: "../../other", messages: [] })).toThrow();
  expect(() =>
    googleRequest({
      model: "gemini-3.6-flash",
      messages: [
        { role: "user", content: [{ type: "audio", data: "unsupported" }] },
      ],
    }),
  ).toThrow();
});

test.each([
  'data: {"error":{"code":429,"message":"private provider detail"}}\n\n',
  '{"error":{"code":429,"message":"private provider detail"}}',
  'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
  'data: {"candidates":',
])(
  "failed or truncated native streams cannot become successful completions: %s",
  async (wire) => {
    const response = await googleResponse(
      new Response(wire),
      "gemini-3.6-flash",
      true,
    );
    const text = await response.text();
    expect(text).toContain('"error"');
    expect(text).not.toContain("private provider detail");
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).not.toContain("[DONE]");
  },
);
