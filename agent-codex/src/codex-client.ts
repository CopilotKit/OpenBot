import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

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

type ThreadStartResult = {
  thread: { id: string };
};

type TurnStartResult = {
  turn: { id: string };
};

type TurnCallbacks = {
  onText(delta: string): void;
};

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 180_000;

/** Minimal JSON-RPC client for the local Codex app-server stdio transport. */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private listeners = new Set<(message: JsonRpcMessage) => void>();
  private account: AccountSummary | undefined;

  async start(): Promise<void> {
    if (this.child) return;

    const binary = process.env.CODEX_BINARY?.trim() || "codex";
    const child = spawn(binary, ["app-server", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        version: "0.0.1",
      },
      capabilities: null,
    });
    this.notify("initialized", {});

    const result = (await this.request("account/read", {
      refreshToken: false,
    })) as {
      account?: { type?: string; planType?: string | null } | null;
      requiresOpenaiAuth?: boolean;
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
  ): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "openbot_local_codex",
      developerInstructions,
      ephemeral: false,
    })) as ThreadStartResult;
    if (!result.thread?.id) {
      throw new Error("Codex app-server did not return a thread id.");
    }
    return result.thread.id;
  }

  async runTurn(
    threadId: string,
    cwd: string,
    prompt: string,
    callbacks: TurnCallbacks,
  ): Promise<void> {
    let turnId: string | undefined;
    let turnError: string | undefined;
    const streamedItems = new Set<string>();
    const timeoutMs = Number.parseInt(
      process.env.CODEX_AGENT_TURN_TIMEOUT_MS ?? `${DEFAULT_TURN_TIMEOUT_MS}`,
      10,
    );

    let finish: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const timeout = setTimeout(() => {
      fail?.(new Error(`Codex did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);

    const unsubscribe = this.onMessage((message) => {
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;

      if (message.method === "item/agentMessage/delta") {
        if (turnId && params.turnId !== turnId) return;
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (itemId) streamedItems.add(itemId);
        if (delta) callbacks.onText(delta);
        return;
      }

      if (message.method === "item/completed") {
        if (turnId && params.turnId !== turnId) return;
        const item = params.item as
          | { type?: string; id?: string; text?: string }
          | undefined;
        if (
          item?.type === "agentMessage" &&
          item.id &&
          !streamedItems.has(item.id) &&
          item.text
        ) {
          callbacks.onText(item.text);
        }
        return;
      }

      if (message.method === "error") {
        const error = params.error as { message?: string } | undefined;
        turnError = error?.message ?? "Codex reported an unknown error.";
        return;
      }

      if (message.method === "turn/completed") {
        const turn = params.turn as
          | {
              id?: string;
              status?: string;
              error?: { message?: string } | null;
            }
          | undefined;
        if (turnId && turn?.id !== turnId) return;
        if (turn?.status === "completed") {
          finish?.();
        } else {
          fail?.(
            new Error(
              turnError ??
                turn?.error?.message ??
                `Codex turn ended with status ${turn?.status ?? "unknown"}.`,
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
        sandboxPolicy: { type: "readOnly" },
        effort: "low",
      })) as TurnStartResult;
      turnId = result.turn?.id;
      if (!turnId)
        throw new Error("Codex app-server did not return a turn id.");
      await completed;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
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
      this.answerServerRequest(message);
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

  /** The spike never authorizes Codex-native actions; OpenBot tool bridging comes later. */
  private answerServerRequest(message: JsonRpcMessage): void {
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      this.write({ id: message.id, result: { decision: "decline" } });
      return;
    }
    this.write({
      id: message.id,
      error: {
        code: -32601,
        message:
          "This OpenBot compatibility spike does not expose that action.",
      },
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
