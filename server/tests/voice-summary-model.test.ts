import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { RunAgentInput } from "@ag-ui/client";
import { runtimeModelForEnvironment } from "../src/copilot";
import {
  encryptSecret,
  resolveModelApiKey,
  type ModelCredentialSecretReader,
} from "../src/credentials";
import {
  createProviderOAuthProxy,
  mountProviderOAuthProxy,
  type ModelOAuthRecord,
} from "../src/provider-oauth";
import { createVoiceSummarizer } from "../src/voice/summary";

const transcript = [
  { id: "turn-1", role: "user", text: "Plan the launch." },
] as const;
const answer = "Discussed launch planning. Next steps remain open.";
const packageModel = { provider: "openai", defaultModel: "gpt-test" } as const;
const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function summarizer(
  environment: Record<string, string | undefined>,
  reader: ModelCredentialSecretReader = { readModelSecret: async () => null },
) {
  const model = runtimeModelForEnvironment(packageModel, environment);
  return createVoiceSummarizer({
    model,
    environment,
    timeoutMs: 1000,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey,
        reader,
        provider: model.provider,
        keyId: "primary-model",
        environment,
      }),
  });
}

test.each(["openai", "anthropic"] as const)(
  "voice summaries use the selected %s API credential and protocol, including rotation",
  async (provider) => {
    const seen: {
      path: string;
      authorization: string | null;
      apiKey: string | null;
      body: unknown;
    }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          body: await request.json(),
        });
        return Response.json(
          provider === "anthropic"
            ? {
                content: [
                  { type: "thinking", thinking: "private" },
                  { type: "text", text: answer },
                ],
              }
            : { choices: [{ message: { content: answer } }] },
        );
      },
    });
    try {
      const environment = {
        BOT_PROVIDER: provider,
        BOT_MODEL: "selected-model",
        OPENAI_BASE_URL: `${server.url.origin}/gateway/v1/`,
        ANTHROPIC_BASE_URL: `${server.url.origin}/gateway/v1/`,
        ...(provider === "anthropic"
          ? { ANTHROPIC_API_KEY: "environment-key" }
          : { OPENAI_API_KEY: "environment-key" }),
        VOICE_API_KEY: "must-not-be-used",
      };
      let encryptedValue: string | undefined;
      const summarize = summarizer(environment, {
        readModelSecret: async (input) => {
          expect(input).toEqual({ provider, keyId: "primary-model" });
          return encryptedValue ? { encryptedValue } : null;
        },
      });
      expect(await summarize(transcript)).toBe(answer);
      encryptedValue = await encryptSecret(encryptionKey, "rotated-stored-key");
      expect(await summarize(transcript)).toBe(answer);
      expect(seen).toHaveLength(2);
      for (const [index, request] of seen.entries()) {
        const key = index === 0 ? "environment-key" : "rotated-stored-key";
        expect(request.path).toBe(
          `/gateway/v1/${provider === "anthropic" ? "messages" : "chat/completions"}`,
        );
        expect(request.authorization).toBe(
          provider === "anthropic" ? null : `Bearer ${key}`,
        );
        expect(request.apiKey).toBe(provider === "anthropic" ? key : null);
        expect(request.body).toMatchObject({ model: "selected-model" });
        expect(JSON.stringify(request.body)).toContain("untrusted");
        expect(JSON.stringify(request.body)).toContain("Plan the launch.");
      }
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["claude", "chatgpt"] as const)(
  "voice summaries use the authenticated %s plan without an API key and isolate each call",
  async (provider) => {
    const requests: RunAgentInput[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe(
          provider === "claude" ? "/model" : "/",
        );
        expect(request.headers.get("x-openbot-agent-token")).toBe(
          "owned-harness-token",
        );
        expect(request.headers.get("authorization")).toBeNull();
        const body: RunAgentInput = await request.json();
        requests.push(body);
        return new Response(
          [
            { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
            {
              type: "TEXT_MESSAGE_START",
              messageId: "reply",
              role: "assistant",
            },
            { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: answer },
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
      const summarize = summarizer(
        {
          ...(provider === "claude"
            ? { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-plan-token" }
            : { CHATGPT_AUTH_FILE: "/synthetic/auth.json" }),
          PICKED_HARNESS_IMAGE:
            provider === "claude"
              ? "agent-claude-sdk:test"
              : "agent-langgraph-agui:test",
          PICKED_HARNESS_URL: server.url.origin,
          MANAGED_AGENT_TOKEN: "owned-harness-token",
        },
        {
          readModelSecret: async () => {
            throw new Error("Plan summaries must not look for an API key");
          },
        },
      );
      expect(await summarize(transcript)).toBe(answer);
      expect(await summarize(transcript)).toBe(answer);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.threadId).not.toBe(requests[1]?.threadId);
      for (const request of requests) {
        expect(request.tools).toEqual([]);
        expect(request.forwardedProps.openbotModelOnly).toBe(true);
        expect(JSON.stringify(request.context)).toContain("untrusted");
        expect(JSON.stringify(request.messages)).toContain("Plan the launch.");
        expect(JSON.stringify(request)).not.toContain("synthetic-plan-token");
      }
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["google", "xai"] as const)(
  "voice summaries reuse the authenticated native %s OAuth proxy",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "openbot-voice-summary-"));
    const file = join(root, "oauth.json");
    const record: ModelOAuthRecord = {
      version: 1,
      sessionId: "synthetic-session",
      provider,
      clientId: "synthetic-client",
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      scope: "model",
      quotaProject: "synthetic-quota",
      proxyToken: "synthetic-proxy-token",
    };
    const received: {
      url: string;
      authorization: string | null;
      body: unknown;
    }[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json(
          provider === "google"
            ? {
                candidates: [
                  {
                    content: { parts: [{ text: answer }] },
                    finishReason: "STOP",
                  },
                ],
              }
            : { choices: [{ message: { content: answer } }] },
        );
      },
    });
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await writeFile(file, JSON.stringify(record), { mode: 0o600 });
      const app = new Hono();
      mountProviderOAuthProxy(
        app,
        createProviderOAuthProxy(file, {
          fetch: (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            return fetch(new URL(url.pathname, upstream.url), init);
          },
        }),
      );
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      const environment = {
        BOT_PROVIDER: "openai",
        BOT_MODEL: "selected-model",
        OPENAI_BASE_URL: `${server.url.origin}/api/model-provider/v1`,
        OPENAI_API_KEY: record.proxyToken,
        OPENBOT_MODEL_OAUTH_FILE: file,
      };
      expect(await summarizer(environment)(transcript)).toBe(answer);
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe(`Bearer ${record.accessToken}`);
      expect(new URL(received[0]?.url ?? "").pathname).toBe(
        provider === "google"
          ? "/v1beta/models/selected-model:generateContent"
          : "/v1/chat/completions",
      );
      expect(JSON.stringify(received[0]?.body)).toContain("Plan the launch.");
      expect(JSON.stringify(received[0]?.body)).toContain("untrusted");
      expect(JSON.stringify(received[0]?.body)).not.toContain(
        record.proxyToken,
      );
      await expect(
        summarizer({ ...environment, OPENAI_API_KEY: "wrong-proxy-token" })(
          transcript,
        ),
      ).rejects.toThrow("401");
      expect(received).toHaveLength(1);
    } finally {
      await server?.stop(true);
      await upstream.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["claude", "chatgpt"] as const)(
  "voice summaries reject %s plan errors and abort stalled streams",
  async (provider) => {
    let fail = true;
    let cancelled = 0;
    let closed = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("/cancel")) {
          cancelled++;
          return Response.json({ ok: true });
        }
        const body: RunAgentInput = await request.json();
        const events = fail
          ? [{ type: "RUN_ERROR", message: "Synthetic plan refusal" }]
          : [
              {
                type: "RUN_STARTED",
                threadId: body.threadId,
                runId: body.runId,
              },
            ];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events)
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            if (fail) controller.close();
            else
              request.signal.addEventListener(
                "abort",
                () => {
                  closed = true;
                  controller.close();
                },
                { once: true },
              );
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const summarize = summarizer({
        ...(provider === "claude"
          ? { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-plan-token" }
          : { CHATGPT_AUTH_FILE: "/synthetic/auth.json" }),
        PICKED_HARNESS_IMAGE:
          provider === "claude"
            ? "agent-claude-sdk:test"
            : "agent-langgraph-agui:test",
        PICKED_HARNESS_URL: server.url.origin,
        MANAGED_AGENT_TOKEN: "owned-harness-token",
      });
      await expect(summarize(transcript)).rejects.toThrow(
        "Synthetic plan refusal",
      );
      fail = false;
      await expect(summarize(transcript)).rejects.toThrow();
      // Observe the abort at the fixture boundary, not only a rejected local promise.
      for (
        let i = 0;
        i < 50 && (!closed || (provider === "claude" && cancelled < 2));
        i++
      )
        await Bun.sleep(10);
      expect(closed).toBe(true);
      expect(cancelled).toBe(provider === "claude" ? 2 : 0);
    } finally {
      await server.stop(true);
    }
  },
  5000,
);
