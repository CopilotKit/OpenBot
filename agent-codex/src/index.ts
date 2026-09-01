import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { CodexAppServerClient } from "./codex-client";
import { recoveredThreadPrompt, toCodexTurnInput } from "./history";
import { CodexThreadStore } from "./thread-store";
import {
  dynamicToolsOf,
  OpenBotToolGateway,
  runAssertionOf,
  toolCatalogueFingerprint,
} from "./tools";

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. The Codex coworker will not start without OpenBot authentication.",
  );
  process.exit(1);
}

const TOOL_TOKEN = process.env.AGENT_TOOL_TOKEN?.trim();
if (!TOOL_TOKEN) {
  console.error(
    "AGENT_TOOL_TOKEN is not set. The Codex coworker only runs tools through OpenBot's governance gateway.",
  );
  process.exit(1);
}

const WORKSPACE = resolve(
  process.env.CODEX_AGENT_WORKSPACE?.trim() || ".openbot-codex/workspace",
);
const STATE_PATH = resolve(
  process.env.CODEX_AGENT_STATE?.trim() || ".openbot-codex/threads.json",
);
const TOOL_URL =
  process.env.OPENBOT_TOOL_URL?.trim() ||
  "http://localhost:3001/api/agent-tools/call";
await mkdir(WORKSPACE, { recursive: true });

const threadStore = await CodexThreadStore.open(STATE_PATH);
const gateway = new OpenBotToolGateway({ url: TOOL_URL, token: TOOL_TOKEN });
const codex = new CodexAppServerClient();
await codex.start();

const threadQueues = new Map<string, Promise<void>>();

async function runAgent(
  input: RunAgentInput,
  requestSignal: AbortSignal,
): Promise<Response> {
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

      let messageSequence = 0;
      let messageId = "";
      let textOpen = false;
      let visibleReceived = false;
      const closeText = () => {
        if (!textOpen) return;
        send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        textOpen = false;
      };

      try {
        await serialiseThread(input.threadId, async () => {
          const turn = toCodexTurnInput(input);
          const dynamicTools = dynamicToolsOf(input);
          const toolCatalogue = toolCatalogueFingerprint(dynamicTools);
          const allowedToolNames = new Set(
            dynamicTools.map((tool) => tool.name),
          );
          const runAssertion = runAssertionOf(input);
          let codexThreadId = threadStore.get(input.threadId);
          let prompt = turn.prompt;
          if (
            codexThreadId &&
            threadStore.catalogue(input.threadId) === toolCatalogue
          ) {
            await codex.resumeThread(
              codexThreadId,
              WORKSPACE,
              turn.developerInstructions,
            );
          } else {
            const replacesStaleThread = Boolean(codexThreadId);
            codexThreadId = await codex.startThread(
              WORKSPACE,
              turn.developerInstructions,
              dynamicTools,
            );
            // Persist before the first turn. A crash can orphan an empty Codex thread, but it can
            // never produce conversation state that OpenBot subsequently forgets how to resume.
            await threadStore.remember(
              input.threadId,
              codexThreadId,
              toolCatalogue,
            );
            if (replacesStaleThread) {
              prompt = recoveredThreadPrompt(input, turn.prompt);
            }
          }

          await codex.runTurn(
            codexThreadId,
            WORKSPACE,
            prompt,
            {
              onText(delta) {
                if (!textOpen) {
                  messageId = `msg_${input.runId}_${messageSequence++}`;
                  send({
                    type: "TEXT_MESSAGE_START",
                    messageId,
                    role: "assistant",
                  } as BaseEvent);
                  textOpen = true;
                }
                visibleReceived = true;
                send({
                  type: "TEXT_MESSAGE_CONTENT",
                  messageId,
                  delta,
                } as BaseEvent);
              },
              async onToolCall(callId, name, args) {
                closeText();
                visibleReceived = true;
                send({
                  type: "TOOL_CALL_START",
                  toolCallId: callId,
                  toolCallName: name,
                } as BaseEvent);
                send({
                  type: "TOOL_CALL_ARGS",
                  toolCallId: callId,
                  delta: JSON.stringify(args),
                } as BaseEvent);
                send({
                  type: "TOOL_CALL_END",
                  toolCallId: callId,
                } as BaseEvent);

                const result = allowedToolNames.has(name)
                  ? await gateway.call(runAssertion, name, args, requestSignal)
                  : {
                      text: `Refused. ${name} was not granted to this Codex turn by OpenBot.`,
                      success: false,
                    };
                send({
                  type: "TOOL_CALL_RESULT",
                  messageId: `${callId}-result`,
                  toolCallId: callId,
                  content: result.text,
                  role: "tool",
                } as BaseEvent);
                return result;
              },
            },
            requestSignal,
          );
        });

        closeText();
        if (!visibleReceived) {
          throw new Error(
            "Codex completed without returning text or calling an OpenBot tool.",
          );
        }
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        closeText();
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

async function serialiseThread<T>(
  threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = threadQueues.get(threadId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  threadQueues.set(threadId, queued);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release?.();
    if (threadQueues.get(threadId) === queued) threadQueues.delete(threadId);
  }
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
        safety: "openbot-governed-tools",
        threadRecovery: "persistent",
        persistedThreads: threadStore.size(),
      });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      return runAgent((await request.json()) as RunAgentInput, request.signal);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

const account = codex.accountSummary();
console.info(
  `agent-codex listening on http://localhost:${PORT}/ag-ui (${account.authMode}, ${account.planType ?? "unknown plan"}; persistent threads; OpenBot-governed tools)`,
);
