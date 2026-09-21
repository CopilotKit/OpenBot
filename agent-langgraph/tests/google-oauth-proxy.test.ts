import { expect, test } from "bun:test";
import { RunAgentInputSchema } from "@ag-ui/core";
import type { AIMessageChunk } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  googleRequest,
  googleResponse,
} from "../../server/src/google-oauth-transport";
import { toLangChainMessages } from "../src/history";

test("LangGraph streams and replays Gemini tool signatures through its actual SDK and AG-UI history", async () => {
  const signature = `${"aBc012+/".repeat(512)}==`;
  let calls = 0;
  const nativeBodies: ReturnType<typeof googleRequest>["body"][] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const converted = googleRequest(await request.json());
      nativeBodies.push(converted.body);
      calls++;
      const parts =
        calls === 1
          ? [
              {
                functionCall: {
                  id: "native_browser_1",
                  name: "browser",
                  args: { url: "https://example.com" },
                },
                thoughtSignature: signature,
              },
            ]
          : [{ text: "Page loaded." }];
      return googleResponse(
        new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
        converted.model,
        true,
      );
    },
  });
  try {
    const model = new ChatOpenAI({
      model: "gemini-3.6-flash",
      apiKey: "local-fixture-token",
      configuration: { baseURL: `${server.url}v1` },
      useResponsesApi: false,
      maxRetries: 0,
    });
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "browser",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
    ];
    let message: AIMessageChunk | undefined;
    for await (const chunk of await model
      .bindTools(tools)
      .stream("Open example.com"))
      message = message ? message.concat(chunk) : chunk;
    const call = message?.tool_calls?.[0];
    expect(call?.id).toBe(`native_browser_1__thought__${signature}`);
    const history = RunAgentInputSchema.parse({
      threadId: "fixture-thread",
      runId: "fixture-run",
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      messages: [
        { id: "user-1", role: "user", content: "Open example.com" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: call?.id,
              type: "function",
              function: {
                name: call?.name,
                arguments: JSON.stringify(call?.args),
              },
            },
          ],
        },
        {
          id: "result-1",
          role: "tool",
          toolCallId: call?.id,
          content: "The page loaded",
        },
      ],
    });
    let answer = "";
    for await (const chunk of await model
      .bindTools(tools)
      .stream(toLangChainMessages(history)))
      answer += chunk.content;
    expect(answer).toBe("Page loaded.");
    expect(nativeBodies[1].contents[1].parts).toEqual([
      {
        functionCall: {
          id: "native_browser_1",
          name: "browser",
          args: { url: "https://example.com" },
        },
        thoughtSignature: signature,
      },
    ]);
    expect(nativeBodies[1].contents[2].parts).toEqual([
      {
        functionResponse: {
          id: "native_browser_1",
          name: "browser",
          response: { result: "The page loaded" },
        },
      },
    ]);
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
  }
});
