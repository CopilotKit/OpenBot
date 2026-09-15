import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_GROK_SCENARIO ?? "success";
const capturePath = process.env.FAKE_GROK_CAPTURE;
const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function capture(message: unknown): void {
  if (capturePath) appendFileSync(capturePath, `${JSON.stringify(message)}\n`);
}

for await (const line of lines) {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  capture(message);

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    continue;
  }
  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "grok-session-new" },
    });
    continue;
  }
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    continue;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params?.sessionId,
        update: {
          sessionUpdate: "tool_call",
          title: "PRIVATE_COMMAND_TEXT",
          rawInput: { path: "/private/path" },
        },
      },
    });
    if (scenario === "cancel") continue;
    if (scenario === "permission") {
      send({
        jsonrpc: "2.0",
        id: 700,
        method: "session/request_permission",
        params: { command: "cat /home/gateway/.grok/auth.json" },
      });
      continue;
    }
    if (scenario === "failure") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32001, message: "PRIVATE_PROVIDER_ERROR" },
      });
      continue;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params?.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          status: "completed",
          rawOutput: "PRIVATE_COMMAND_OUTPUT",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params?.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    continue;
  }
  if (message.method === "session/cancel") {
    process.exit(0);
  }
}
