import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";
const capturePath = process.env.FAKE_CODEX_CAPTURE;
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
    send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
  }
  if (message.method === "initialized") continue;

  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "codex-thread-new" } } });
    continue;
  }
  if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: message.params?.threadId } },
    });
    continue;
  }

  if (message.method === "turn/start") {
    send({
      id: message.id,
      result: { turn: { id: "codex-turn-1", status: "inProgress", items: [] } },
    });
    send({
      method: "item/started",
      params: {
        threadId: message.params?.threadId,
        turnId: "codex-turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "PRIVATE_COMMAND_TEXT",
          cwd: "/private/path",
          status: "inProgress",
        },
      },
    });

    if (scenario === "cancel") continue;
    if (scenario === "approval") {
      send({
        id: 700,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: message.params?.threadId,
          turnId: "codex-turn-1",
          itemId: "command-1",
          command: "cat /home/gateway/.codex/auth.json",
        },
      });
      continue;
    }
    if (scenario === "failure") {
      send({
        method: "error",
        params: { error: { message: "PRIVATE_PROVIDER_ERROR" } },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: message.params?.threadId,
          turn: {
            id: "codex-turn-1",
            status: "failed",
            error: { message: "PRIVATE_PROVIDER_ERROR" },
          },
        },
      });
      continue;
    }

    send({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: message.params?.threadId,
        turnId: "codex-turn-1",
        itemId: "command-1",
        delta: "PRIVATE_COMMAND_OUTPUT",
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: message.params?.threadId,
        turnId: "codex-turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          status: "completed",
        },
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: message.params?.threadId,
        turnId: "codex-turn-1",
        itemId: "message-1",
        delta: "Done.",
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params?.threadId,
        turn: { id: "codex-turn-1", status: "completed", items: [] },
      },
    });
    continue;
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params?.threadId,
        turn: { id: message.params?.turnId, status: "interrupted", items: [] },
      },
    });
  }
}
