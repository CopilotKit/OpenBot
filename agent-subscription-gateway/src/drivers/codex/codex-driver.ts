import { isAbsolute } from "node:path";
import {
  type AgentDriver,
  type DriverEvent,
  type DriverResumeRun,
  type DriverRun,
  type DriverRunContext,
  SafeDriverError,
} from "../agent-driver";

interface WritableInput {
  write(chunk: string | Uint8Array): number | Promise<number>;
  flush?(): number | Promise<number>;
  end(): unknown;
}

export interface CodexChildProcess {
  stdin: WritableInput;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(exitCode?: number): unknown;
}

export interface CodexSpawnOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export type CodexProcessFactory = (
  options: CodexSpawnOptions,
) => CodexChildProcess;

interface JsonObject {
  [key: string]: unknown;
}

type RpcId = string | number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface ActiveRun {
  connection: CodexConnection;
  threadId?: string;
  turnId?: string;
}

const SAFE_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

function safeEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_NAMES.has(name)) {
      environment[name] = value;
    }
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  private failure?: unknown;
  private ended = false;

  push(value: T): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  fail(error: unknown): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* jsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield JSON.parse(line);
      }
    }
    buffered += decoder.decode();
    const finalLine = buffered.trim();
    if (finalLine) yield JSON.parse(finalLine);
  } finally {
    reader.releaseLock();
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of stream) {
    }
  } catch {}
}

class CodexConnection {
  private readonly notifications = new AsyncQueue<JsonObject>();
  private readonly pending = new Map<RpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly process: CodexChildProcess) {
    void drain(process.stderr);
    void this.read();
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new SafeDriverError("The Codex app server stopped."),
      );
    }
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ id, method, params });
    return response;
  }

  notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  events(): AsyncIterable<JsonObject> {
    return this.notifications;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.stop(new SafeDriverError("The Codex app server stopped."));
    this.shutdownPromise = (async () => {
      try {
        this.process.stdin.end();
      } catch {}
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      });
      const exitCode = await Promise.race([this.process.exited, timedOut]);
      if (timer) clearTimeout(timer);
      if (exitCode === undefined) {
        try {
          this.process.kill();
        } catch {}
      }
    })();
    return this.shutdownPromise;
  }

  private send(message: JsonObject): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
      this.process.stdin.flush?.();
    } catch {
      this.stop(new SafeDriverError("The Codex app server stopped."));
    }
  }

  private async read(): Promise<void> {
    try {
      for await (const raw of jsonLines(this.process.stdout)) {
        if (!isObject(raw)) throw new Error("Invalid JSON-RPC message.");
        if (typeof raw.method === "string" && Object.hasOwn(raw, "id")) {
          this.send({
            id: raw.id as RpcId,
            error: {
              code: -32000,
              message: "Interactive requests are disabled by worker policy.",
            },
          });
          const error = new SafeDriverError(
            "The Codex run requested interactive input and was stopped.",
          );
          this.stop(error);
          return;
        }
        if (Object.hasOwn(raw, "id")) {
          const pending = this.pending.get(raw.id as RpcId);
          if (!pending) continue;
          this.pending.delete(raw.id as RpcId);
          if (Object.hasOwn(raw, "error")) {
            pending.reject(
              new SafeDriverError("The Codex app server rejected a request."),
            );
          } else {
            pending.resolve(raw.result);
          }
          continue;
        }
        if (typeof raw.method === "string") this.notifications.push(raw);
      }
      if (!this.closed) {
        this.stop(new SafeDriverError("The Codex app server stopped early."));
      }
    } catch {
      if (!this.closed) {
        this.stop(
          new SafeDriverError("The Codex app server sent invalid data."),
        );
      }
    }
  }

  private stop(error: SafeDriverError): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.notifications.fail(error);
  }
}

function defaultProcessFactory(options: CodexSpawnOptions): CodexChildProcess {
  return Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function requiredWorkspace(run: DriverRun): string {
  if (!run.workspacePath || !isAbsolute(run.workspacePath)) {
    throw new SafeDriverError("The Codex workspace is not available.");
  }
  return run.workspacePath;
}

function transcript(run: DriverRun): string {
  const parts: string[] = [];
  for (const raw of run.messages) {
    if (!isObject(raw)) continue;
    const { id, role, content } = raw;
    if (
      typeof id !== "string" ||
      typeof role !== "string" ||
      typeof content !== "string"
    ) {
      continue;
    }
    parts.push(`[${role} ${id}]\n${content}`);
  }
  if (parts.length === 0) {
    throw new SafeDriverError("The Codex run has no transcript input.");
  }
  return `OpenBot transcript:\n\n${parts.join("\n\n")}`;
}

function resultObject(result: unknown): JsonObject {
  if (!isObject(result)) {
    throw new SafeDriverError("The Codex app server returned invalid data.");
  }
  return result;
}

function nestedId(result: unknown, field: string): string {
  const record = resultObject(result);
  const nested = record[field];
  if (!isObject(nested) || typeof nested.id !== "string" || !nested.id) {
    throw new SafeDriverError("The Codex app server returned invalid data.");
  }
  return nested.id;
}

function itemActivity(message: JsonObject): DriverEvent | undefined {
  const method = message.method;
  const params = isObject(message.params) ? message.params : undefined;
  const item = params && isObject(params.item) ? params.item : undefined;
  if (method === "item/commandExecution/outputDelta") {
    return {
      type: "activity",
      message: "Command produced output",
      data: { itemType: "commandExecution" },
    };
  }
  if ((method !== "item/started" && method !== "item/completed") || !item) {
    return undefined;
  }
  const itemType = typeof item.type === "string" ? item.type : "nativeAction";
  const status = typeof item.status === "string" ? item.status : undefined;
  const action =
    itemType === "commandExecution"
      ? "Command"
      : itemType === "fileChange"
        ? "File change"
        : itemType === "mcpToolCall"
          ? "MCP call"
          : itemType === "webSearch"
            ? "Web search"
            : "Native action";
  return {
    type: "activity",
    message: `${action} ${method === "item/started" ? "started" : "completed"}`,
    data: { itemType, ...(status ? { status } : {}) },
  };
}

function otherActivity(message: JsonObject): DriverEvent | undefined {
  const method = message.method;
  if (method === "turn/diff/updated") {
    return { type: "activity", message: "Repository diff updated" };
  }
  if (method === "turn/plan/updated") {
    return { type: "activity", message: "Plan updated" };
  }
  if (method === "hook/started") {
    return { type: "activity", message: "Hook started" };
  }
  if (method === "hook/completed") {
    return { type: "activity", message: "Hook completed" };
  }
  if (method === "warning" || method === "configWarning") {
    return { type: "activity", message: "Codex reported a warning" };
  }
  return undefined;
}

export interface CodexDriverOptions {
  processFactory?: CodexProcessFactory;
  binary?: string;
  version?: string;
  environment?: Record<string, string | undefined>;
  interruptTimeoutMs?: number;
  permissionProfile?: string;
}

export class CodexDriver implements AgentDriver {
  readonly provider = "codex";
  readonly version: string;
  private readonly processFactory: CodexProcessFactory;
  private readonly binary: string;
  private readonly environment: Record<string, string>;
  private readonly interruptTimeoutMs: number;
  private readonly permissionProfile: string;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: CodexDriverOptions = {}) {
    this.processFactory = options.processFactory ?? defaultProcessFactory;
    this.binary = options.binary ?? "codex";
    this.version = options.version ?? process.env.CODEX_VERSION ?? "unknown";
    this.environment = safeEnvironment({
      ...process.env,
      ...options.environment,
    });
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 3_000;
    this.permissionProfile = options.permissionProfile ?? "openbot-worker";
  }

  async isAuthReady(): Promise<boolean> {
    let child: CodexChildProcess;
    try {
      child = this.processFactory({
        command: [this.binary, "login", "status"],
        cwd: process.cwd(),
        env: this.environment,
      });
    } catch {
      return false;
    }
    void drain(child.stdout);
    void drain(child.stderr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 5_000);
    });
    const exitCode = await Promise.race([child.exited, timedOut]);
    if (timer) clearTimeout(timer);
    if (exitCode === undefined) {
      try {
        child.kill();
      } catch {}
      return false;
    }
    return exitCode === 0;
  }

  start(run: DriverRun, context: DriverRunContext): AsyncIterable<DriverEvent> {
    return this.execute(run, context);
  }

  resume(
    run: DriverResumeRun,
    context: DriverRunContext,
  ): AsyncIterable<DriverEvent> {
    return this.execute(run, context, run.sessionId);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    if (!active.threadId || !active.turnId) {
      await active.connection.shutdown();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.interruptTimeoutMs);
    });
    try {
      await Promise.race([
        active.connection.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        }),
        timedOut,
      ]);
    } catch {
    } finally {
      if (timer) clearTimeout(timer);
      await active.connection.shutdown();
    }
  }

  private async *execute(
    run: DriverRun,
    context: DriverRunContext,
    sessionId?: string,
  ): AsyncGenerator<DriverEvent> {
    const workspace = requiredWorkspace(run);
    const child = this.processFactory({
      command: [this.binary, "app-server"],
      cwd: workspace,
      env: this.environment,
    });
    const connection = new CodexConnection(child);
    const active: ActiveRun = { connection };
    if (this.active.has(run.runId)) {
      await connection.shutdown();
      throw new SafeDriverError("The Codex run is already active.");
    }
    this.active.set(run.runId, active);
    const onAbort = () => void this.cancel(run.runId);
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await connection.request("initialize", {
        clientInfo: {
          name: "openbot_subscription_gateway",
          title: "OpenBot Subscription Gateway",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      connection.notify("initialized", {});

      const threadResult = sessionId
        ? await connection.request("thread/resume", {
            threadId: sessionId,
            cwd: workspace,
            approvalPolicy: "never",
            permissions: this.permissionProfile,
          })
        : await connection.request("thread/start", {
            cwd: workspace,
            approvalPolicy: "never",
            permissions: this.permissionProfile,
            serviceName: "openbot_subscription_gateway",
          });
      const threadId = nestedId(threadResult, "thread");
      active.threadId = threadId;
      if (!sessionId) yield { type: "session", sessionId: threadId };

      const turnResult = await connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: transcript(run) }],
        cwd: workspace,
        approvalPolicy: "never",
      });
      active.turnId = nestedId(turnResult, "turn");

      for await (const message of connection.events()) {
        const method = message.method;
        const params = isObject(message.params) ? message.params : undefined;
        if (method === "item/agentMessage/delta") {
          const delta = params?.delta;
          if (typeof delta === "string" && delta) yield { type: "text", delta };
          continue;
        }
        if (method === "error") continue;
        if (method === "turn/completed") {
          const turn =
            params && isObject(params.turn) ? params.turn : undefined;
          if (!turn || typeof turn.status !== "string") {
            throw new SafeDriverError(
              "The Codex app server returned invalid data.",
            );
          }
          if (turn.status === "completed") return;
          if (turn.status === "interrupted" && context.signal.aborted) return;
          if (turn.status === "interrupted") {
            throw new SafeDriverError("The Codex run was interrupted.");
          }
          throw new SafeDriverError("The Codex run failed.");
        }
        const activity = itemActivity(message) ?? otherActivity(message);
        if (activity) yield activity;
      }
      throw new SafeDriverError("The Codex app server stopped early.");
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (this.active.get(run.runId) === active) this.active.delete(run.runId);
      await connection.shutdown();
    }
  }
}
