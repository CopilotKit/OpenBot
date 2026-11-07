import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { createChannelTitler } from "../src/channels/titler";
import { runtimeModelForEnvironment } from "../src/copilot";
import { resolveModelApiKey } from "../src/credentials";

function respondWith(body: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("asking the model for a title", () => {
  test("sends the excerpt to the deployment's own model", async () => {
    const { calls, fetchImpl } = respondWith({
      choices: [{ message: { content: "Travel receipt rules" } }],
    });

    const answer = await createChannelTitler({
      model: "gpt-4.1-mini",
      resolveApiKey: async () => "key-123",
      environment: {},
      fetchImpl,
    })("Asked: which receipts count as travel?");

    expect(answer).toBe("Travel receipt rules");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("gpt-4.1-mini");
  });

  test("asks the endpoint OPENAI_BASE_URL names, not OpenAI", async () => {
    const { calls, fetchImpl } = respondWith({
      choices: [{ message: { content: "Travel receipt rules" } }],
    });

    await createChannelTitler({
      model: "openai/gpt-5.6-terra",
      resolveApiKey: async () => "gateway-key",
      environment: { OPENAI_BASE_URL: "https://gateway.internal/v1" },
      fetchImpl,
    })("Asked: which receipts count as travel?");

    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.internal/v1/chat/completions",
    ]);
  });

  test("reads OPENAI_BASE_URL from the process when no environment is passed", async () => {
    const { calls, fetchImpl } = respondWith({
      choices: [{ message: { content: "Travel receipt rules" } }],
    });
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "http://localhost:4010";
    try {
      await createChannelTitler({
        model: "gpt-4.1-mini",
        resolveApiKey: async () => "gateway-key",
        fetchImpl,
      })("Asked: anything?");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
    }

    expect(calls[0]?.url).toBe("http://localhost:4010/v1/chat/completions");
  });

  test("asks nothing at all when the deployment has no key", async () => {
    const { calls, fetchImpl } = respondWith({});

    const answer = await createChannelTitler({
      model: "gpt-4.1-mini",
      resolveApiKey: async () => null,
      fetchImpl,
    })("Asked: anything?");

    // Not a failure. A deployment with no model configured does not name conversations, and must
    // not spend a request finding that out on every pass.
    expect(answer).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("throws when the provider refuses, so the work is tried again", async () => {
    const { fetchImpl } = respondWith("rate limited", 429);

    await expect(
      createChannelTitler({
        model: "gpt-4.1-mini",
        resolveApiKey: async () => "key-123",
        fetchImpl,
      })("Asked: anything?"),
    ).rejects.toThrow("429");
  });

  test("carries only one line of the provider's complaint", async () => {
    const { fetchImpl } = respondWith(
      "<html>\n  <body>Too many requests</body>\n</html>",
      503,
    );

    // The message ends up on the work item as the reason it was released, so a provider that
    // answers with a page of HTML must not put that page in the database.
    const thrown = await createChannelTitler({
      model: "gpt-4.1-mini",
      resolveApiKey: async () => "key-123",
      fetchImpl,
    })("Asked: anything?").catch((error: Error) => error.message);

    expect(thrown).not.toContain("\n");
  });

  test("an empty completion is no answer rather than an empty title", async () => {
    const { fetchImpl } = respondWith({
      choices: [{ message: { content: "   " } }],
    });

    const answer = await createChannelTitler({
      model: "gpt-4.1-mini",
      resolveApiKey: async () => "key-123",
      fetchImpl,
    })("Asked: anything?");

    expect(answer).toBeNull();
  });
});

describe("a deployment whose Bots run on Anthropic", () => {
  // The titler always spoke OpenAI's Chat Completions, so with BOT_PROVIDER=anthropic it sent the
  // Anthropic key to OpenAI, got a 401, and no conversation was ever named.
  function anthropicAnswer(text: string) {
    const calls: {
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      // The shape the Messages API answers with.
      return Response.json({
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 40, output_tokens: 6 },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("names the conversation on Anthropic's Messages API, with the key in its own header", async () => {
    const { calls, fetchImpl } = anthropicAnswer("Lisbon trip planning");

    const answer = await createChannelTitler({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      resolveApiKey: async () => "sk-ant-test",
      environment: {},
      fetchImpl,
    })("Asked: plan three days in Lisbon.");

    expect(answer).toBe("Lisbon trip planning");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.body.model).toBe("claude-sonnet-5-5");
    expect(typeof calls[0]?.body.system).toBe("string");
    expect(calls[0]?.body.messages).toEqual([
      { role: "user", content: "Asked: plan three days in Lisbon." },
    ]);
  });

  test("asks the endpoint ANTHROPIC_BASE_URL names", async () => {
    const { calls, fetchImpl } = anthropicAnswer("Lisbon trip planning");

    await createChannelTitler({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      resolveApiKey: async () => "sk-ant-test",
      environment: { ANTHROPIC_BASE_URL: "https://gateway.internal/v1" },
      fetchImpl,
    })("Asked: plan three days in Lisbon.");

    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.internal/v1/messages",
    ]);
  });
});

describe("a deployment signed in to a model plan instead of a key", () => {
  /*
   * OpenBot Desktop signed in to a Claude plan writes CLAUDE_CODE_OAUTH_TOKEN and no model key, and a
   * ChatGPT plan writes CHATGPT_AUTH_FILE and none either. The built-in Bots answer through the
   * plan's own harness, but the titler only ever asked a provider with a key, found none, and named
   * nothing: every conversation in the sidebar kept the start of its first message as its name.
   */
  test.each(["claude", "chatgpt"] as const)(
    "names the conversation through the %s plan's own harness, with no API key",
    async (provider) => {
      const requests: RunAgentInput[] = [];
      const harness = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          // The harness OpenBot installed for the plan, on its model-only route, with its token.
          expect(new URL(request.url).pathname).toBe(
            provider === "claude" ? "/model" : "/",
          );
          expect(request.headers.get("x-openbot-agent-token")).toBe(
            "owned-harness-token",
          );
          const body: RunAgentInput = await request.json();
          requests.push(body);
          return new Response(
            [
              {
                type: "RUN_STARTED",
                threadId: body.threadId,
                runId: body.runId,
              },
              {
                type: "TEXT_MESSAGE_START",
                messageId: "reply",
                role: "assistant",
              },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "reply",
                delta: "Lisbon trip planning",
              },
              { type: "TEXT_MESSAGE_END", messageId: "reply" },
              {
                type: "RUN_FINISHED",
                threadId: body.threadId,
                runId: body.runId,
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      try {
        // What the Desktop writes for the plan, read the way `server/src/index.ts` reads it.
        const environment = {
          ...(provider === "claude"
            ? { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-plan-token" }
            : { CHATGPT_AUTH_FILE: "/synthetic/auth.json" }),
          PICKED_HARNESS_IMAGE:
            provider === "claude"
              ? "openbot-agent-claude-sdk:test"
              : "openbot-agent-langgraph-agui:test",
          PICKED_HARNESS_URL: harness.url.origin,
          MANAGED_AGENT_TOKEN: "owned-harness-token",
        };
        const model = runtimeModelForEnvironment(
          { provider: "openai", defaultModel: "gpt-test" },
          environment,
        );
        const title = createChannelTitler({
          provider: model.provider,
          model: model.defaultModel,
          ...(model.plan ? { plan: model.plan } : {}),
          environment,
          resolveApiKey: () =>
            resolveModelApiKey({
              encryptionKey: Buffer.alloc(32, 7).toString("base64"),
              // Nothing stored either: a plan is the whole credential.
              reader: { readModelSecret: async () => null },
              provider: model.provider,
              keyId: "primary-model",
              environment,
            }),
        });

        expect(await title("Asked: plan three days in Lisbon.")).toBe(
          "Lisbon trip planning",
        );
        expect(await title("Asked: plan three days in Porto.")).toBe(
          "Lisbon trip planning",
        );

        expect(requests).toHaveLength(2);
        // Each title is its own question, never a turn in a conversation the harness keeps.
        expect(requests[0]?.threadId).not.toBe(requests[1]?.threadId);
        for (const request of requests) {
          expect(request.tools).toEqual([]);
          expect(request.forwardedProps.openbotModelOnly).toBe(true);
          expect(JSON.stringify(request.context)).toContain(
            "You name conversations",
          );
          expect(JSON.stringify(request.messages)).toContain("Asked: plan");
          expect(JSON.stringify(request)).not.toContain("synthetic-plan-token");
        }
      } finally {
        await harness.stop(true);
      }
    },
  );
});
