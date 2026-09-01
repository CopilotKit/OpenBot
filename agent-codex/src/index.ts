import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { CodexAppServerClient } from "./codex-client";
import { toCodexTurnInput } from "./history";

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. The Codex coworker will not start without OpenBot authentication.",
  );
  process.exit(1);
}

const WORKSPACE = resolve(
  process.env.CODEX_AGENT_WORKSPACE?.trim() || ".openbot-codex/workspace",
);
await mkdir(WORKSPACE, { recursive: true });

const codex = new CodexAppServerClient();
await codex.start();

const codexThreads = new Map<string, string>();

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      const messageId = `msg_${input.runId}`;
      let textOpen = false;
      let textReceived = false;

      try {
        const turn = toCodexTurnInput(input);
        let codexThreadId = codexThreads.get(input.threadId);
        if (!codexThreadId) {
          codexThreadId = await codex.startThread(
            WORKSPACE,
            turn.developerInstructions,
          );
          codexThreads.set(input.threadId, codexThreadId);
        }

        await codex.runTurn(codexThreadId, WORKSPACE, turn.prompt, {
          onText(delta) {
            if (!textOpen) {
              send({
                type: "TEXT_MESSAGE_START",
                messageId,
                role: "assistant",
              } as BaseEvent);
              textOpen = true;
            }
            textReceived = true;
            send({
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta,
            } as BaseEvent);
          },
        });

        if (!textReceived) {
          throw new Error("Codex completed without returning a text message.");
        }
        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "The Codex coworker could not answer.",
        } as BaseEvent);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const account = codex.accountSummary();
      return Response.json({
        status: "ok",
        authMode: account.authMode,
        planType: account.planType,
        safety: "read-only-text-spike",
      });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      return runAgent((await request.json()) as RunAgentInput);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

const account = codex.accountSummary();
console.info(
  `agent-codex listening on http://localhost:${PORT}/ag-ui (${account.authMode}, ${account.planType ?? "unknown plan"})`,
);
