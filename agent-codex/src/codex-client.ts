import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexDynamicTool, ToolResult } from "./tools";

type JsonObject = Record<string, unknown>;
type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type AccountSummary = {
  authMode: string;
  planType: string | null;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ThreadResult = {
  thread: { id: string };
};

type TurnStartResult = {
  turn: { id: string };
};

export type TurnCallbacks = {
  onText(delta: string): void;
  onToolCall(
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult>;
};

type ActiveTurn = {
  turnId?: string;
  callbacks: TurnCallbacks;
  toolCallIds: Set<string>;
  fail(error: Error): void;
};

type SpawnAppServer = () => ChildProcessWithoutNullStreams;

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const BLOCKED_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

/** JSON-RPC client for a local Codex app-server with OpenBot as its only tool boundary. */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private listeners = new Set<(message: JsonRpcMessage) => void>();
  private activeTurns = new Map<string, ActiveTurn>();
  private account: AccountSummary | undefined;
  private safetyConfig: JsonObject = safetyConfigFor([]);

  constructor(private readonly spawnAppServer: SpawnAppServer = launchCodex) {}

  async start(): Promise<void> {
    if (this.child) return;

    const child = this.spawnAppServer();
    this.child = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) console.error(`[codex app-server] ${text}`);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      this.failAll(
        new Error(
          `Codex app-server exited (${signal ?? `status ${code ?? "unknown"}`}).`,
        ),
      );
    });

    await this.request("initialize", {
      clientInfo: {
        name: "openbot_local_codex",
        title: "OpenBot local Codex coworker",
        version: "0.0.2",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});

    const result = (await this.request("account/read", {
      refreshToken: false,
    })) as {
      account?: { type?: string; planType?: string | null } | null;
    };
    if (result.account?.type !== "chatgpt") {
      throw new Error(
        "Codex is not logged in with ChatGPT. Run `codex login` on this Mac first.",
      );
    }
    this.account = {
      authMode: result.account.type,
      planType: result.account.planType ?? null,
    };

    const configResult = (await this.request("config/read", {
      includeLayers: false,
    })) as { config?: { mcp_servers?: unknown } };
    this.safetyConfig = safetyConfigFor(
      isObject(configResult.config?.mcp_servers)
        ? Object.keys(configResult.config.mcp_servers)
        : [],
    );
  }

  accountSummary(): AccountSummary {
    if (!this.account) {
      throw new Error("Codex app-server has not finished starting.");
    }
    return this.account;
  }

  async startThread(
    cwd: string,
    developerInstructions: string,
    dynamicTools: CodexDynamicTool[],
  ): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "openbot_local_codex",
      developerInstructions,
      dynamicTools,
      config: this.safetyConfig,
      ephemeral: false,
    })) as ThreadResult;
    if (!result.thread?.id) {
      throw new Error("Codex app-server did not return a thread id.");
    }
    return result.thread.id;
  }

  async resumeThread(
    threadId: string,
    cwd: string,
    developerInstructions: string,
  ): Promise<void> {
    const result = (await this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions,
      config: this.safetyConfig,
    })) as ThreadResult;
    if (result.thread?.id !== threadId) {
      throw new Error(
        `Codex resumed ${result.thread?.id ?? "no thread"} instead of ${threadId}.`,
      );
    }
  }

  async runTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    callbacks: TurnCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.activeTurns.has(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let turnError: string | undefined;
    const streamedItems = new Set<string>();
    const timeoutMs = turnTimeoutMs();
    let settled = false;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveCompletion?.();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectCompletion?.(error);
    };
    const active: ActiveTurn = { callbacks, toolCallIds: new Set(), fail };
    this.activeTurns.set(threadId, active);

    const interrupt = () => {
      if (!active.turnId) return;
      void this.request("turn/interrupt", {
        threadId,
        turnId: active.turnId,
      }).catch(() => {});
    };
    const abort = () => {
      interrupt();
      fail(
        new Error("OpenBot ended the request before the Codex turn finished."),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(() => {
      interrupt();
      fail(new Error(`Codex did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);

    const unsubscribe = this.onMessage((message) => {
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;
      if (
        active.turnId &&
        typeof params.turnId === "string" &&
        params.turnId !== active.turnId
      )
        return;
      if (!active.turnId && typeof params.turnId === "string") {
        active.turnId = params.turnId;
      }

      if (message.method === "item/started") {
        const item = isObject(params.item) ? params.item : {};
        if (
          typeof item.type === "string" &&
          BLOCKED_ITEM_TYPES.has(item.type)
        ) {
          const error = new Error(
            `Codex attempted the native ${item.type} path. OpenBot refused it because side effects must use a governed OpenBot tool.`,
          );
          interrupt();
          fail(error);
        }
        return;
      }

      if (message.method === "item/agentMessage/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (itemId) streamedItems.add(itemId);
        if (delta) callbacks.onText(delta);
        return;
      }

      if (message.method === "item/completed") {
        const item = isObject(params.item) ? params.item : {};
        if (
          item.type === "agentMessage" &&
          typeof item.id === "string" &&
          !streamedItems.has(item.id) &&
          typeof item.text === "string" &&
          item.text
        ) {
          callbacks.onText(item.text);
        }
        return;
      }

      if (message.method === "error") {
        const error = isObject(params.error) ? params.error : {};
        turnError =
          typeof error.message === "string"
            ? error.message
            : "Codex reported an unknown error.";
        return;
      }

      if (message.method === "turn/completed") {
        const turn = isObject(params.turn) ? params.turn : {};
        if (
          active.turnId &&
          typeof turn.id === "string" &&
          turn.id !== active.turnId
        )
          return;
        if (turn.status === "completed") {
          finish();
        } else {
          const error = isObject(turn.error) ? turn.error : {};
          fail(
            new Error(
              turnError ??
                (typeof error.message === "string"
                  ? error.message
                  : undefined) ??
                `Codex turn ended with status ${String(turn.status ?? "unknown")}.`,
            ),
          );
        }
      }
    });

    try {
      const result = (await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        effort: "low",
      })) as TurnStartResult;
      const startedTurnId = result.turn?.id;
      if (!startedTurnId) {
        throw new Error("Codex app-server did not return a turn id.");
      }
      if (active.turnId && active.turnId !== startedTurnId) {
        throw new Error(
          `Codex sent events for turn ${active.turnId} before starting ${startedTurnId}.`,
        );
      }
      active.turnId = startedTurnId;
      if (signal?.aborted) interrupt();
      await completed;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      this.activeTurns.delete(threadId);
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request ${method} timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ method, id, params });
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  private write(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("Codex app-server is not running.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      console.error("Codex app-server returned a non-JSON line.");
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.answerServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ?? "Codex app-server request failed.",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const listener of this.listeners) listener(message);
  }

  private async answerServerRequest(message: JsonRpcMessage): Promise<void> {
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      this.write({ id: message.id, result: { decision: "decline" } });
      return;
    }

    if (message.method === "item/permissions/requestApproval") {
      this.write({
        id: message.id,
        error: {
          code: -32000,
          message:
            "OpenBot denied the requested native permission. Use an OpenBot dynamic tool instead.",
        },
      });
      return;
    }

    if (message.method === "item/tool/call") {
      const params = message.params ?? {};
      const threadId =
        typeof params.threadId === "string" ? params.threadId : "";
      const active = this.activeTurns.get(threadId);
      const turnId = typeof params.turnId === "string" ? params.turnId : "";
      const callId = typeof params.callId === "string" ? params.callId : "";
      const name = typeof params.tool === "string" ? params.tool : "";
      if (
        !active ||
        !turnId ||
        (active.turnId !== undefined && turnId !== active.turnId) ||
        !callId ||
        !name ||
        params.namespace !== null
      ) {
        this.write({
          id: message.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: "OpenBot refused this tool call because it does not belong to the active turn.",
              },
            ],
            success: false,
          },
        });
        return;
      }
      active.turnId = turnId;

      if (!isObject(params.arguments)) {
        this.write({
          id: message.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: "OpenBot refused this tool call because its arguments were not a JSON object.",
              },
            ],
            success: false,
          },
        });
        return;
      }

      if (active.toolCallIds.has(callId)) {
        this.write({
          id: message.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: "OpenBot refused a duplicate tool call id so the action could not run twice.",
              },
            ],
            success: false,
          },
        });
        return;
      }
      active.toolCallIds.add(callId);

      try {
        const result = await active.callbacks.onToolCall(
          callId,
          name,
          params.arguments,
        );
        this.write({
          id: message.id,
          result: {
            contentItems: [{ type: "inputText", text: result.text }],
            success: result.success,
          },
        });
      } catch (error) {
        this.write({
          id: message.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: `OpenBot's governed tool callback failed: ${
                  error instanceof Error ? error.message : "unknown error"
                }`,
              },
            ],
            success: false,
          },
        });
      }
      return;
    }

    this.write({
      id: message.id,
      error: {
        code: -32601,
        message: "OpenBot does not expose that Codex-native action.",
      },
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.activeTurns.values()) turn.fail(error);
  }
}

function launchCodex(): ChildProcessWithoutNullStreams {
  const binary = process.env.CODEX_BINARY?.trim() || "codex";
  return spawn(binary, ["app-server", "--stdio"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function safetyConfigFor(mcpServerNames: string[]): JsonObject {
  return {
    mcp_servers: Object.fromEntries(
      mcpServerNames.map((name) => [name, { enabled: false }]),
    ),
    features: {
      apps: false,
      plugins: false,
      multi_agent: false,
      hooks: false,
      memories: false,
      goals: false,
      code_mode: { enabled: false },
    },
    web_search: "disabled",
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
    tools: {
      web_search: false,
      view_image: false,
    },
  };
}

function turnTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.CODEX_AGENT_TURN_TIMEOUT_MS ?? `${DEFAULT_TURN_TIMEOUT_MS}`,
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TURN_TIMEOUT_MS;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
