import { isAbsolute } from "node:path";
import {
  type AgentDriver,
  type DriverEvent,
  type DriverResumeRun,
  type DriverRun,
  type DriverRunContext,
  SafeDriverError,
} from "../agent-driver";

interface JsonObject {
  [key: string]: unknown;
}

interface WritableInput {
  write(chunk: string | Uint8Array): number | Promise<number>;
  flush?(): number | Promise<number>;
  end(): unknown;
}

export interface GrokChildProcess {
  stdin: WritableInput;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(exitCode?: number): unknown;
}

export interface GrokSpawnOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export type GrokProcessFactory = (
  options: GrokSpawnOptions,
) => GrokChildProcess;

type RpcId = string | number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  notifyCompletion: boolean;
}

interface ActiveRun {
  connection: GrokConnection;
  sessionId?: string;
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

class GrokConnection {
  private readonly notifications = new AsyncQueue<JsonObject>();
  private readonly pending = new Map<RpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly process: GrokChildProcess) {
    void drain(process.stderr);
    void this.read();
  }

  request(
    method: string,
    params: JsonObject,
    notifyCompletion = false,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new SafeDriverError("The Grok agent stopped."));
    }
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, notifyCompletion });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string, params: JsonObject): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  events(): AsyncIterable<JsonObject> {
    return this.notifications;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.stop(new SafeDriverError("The Grok agent stopped."));
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
      this.stop(new SafeDriverError("The Grok agent stopped."));
    }
  }

  private async read(): Promise<void> {
    try {
      for await (const raw of jsonLines(this.process.stdout)) {
        if (!isObject(raw)) throw new Error("Invalid JSON-RPC message.");
        if (typeof raw.method === "string" && Object.hasOwn(raw, "id")) {
          this.send({
            jsonrpc: "2.0",
            id: raw.id as RpcId,
            error: {
              code: -32000,
              message: "Interactive requests are disabled by worker policy.",
            },
          });
          this.stop(
            new SafeDriverError(
              "The Grok run requested permission beyond worker policy.",
            ),
          );
          return;
        }
        if (Object.hasOwn(raw, "id")) {
          const pending = this.pending.get(raw.id as RpcId);
          if (!pending) continue;
          this.pending.delete(raw.id as RpcId);
          if (pending.notifyCompletion) {
            this.notifications.push({
              method: "$request/completed",
              params: { id: raw.id as RpcId },
            });
          }
          if (Object.hasOwn(raw, "error")) {
            pending.reject(
              new SafeDriverError("The Grok agent rejected a request."),
            );
          } else {
            pending.resolve(raw.result);
          }
          continue;
        }
        if (typeof raw.method === "string") this.notifications.push(raw);
      }
      if (!this.closed) {
        this.stop(new SafeDriverError("The Grok agent stopped early."));
      }
    } catch {
      if (!this.closed) {
        this.stop(new SafeDriverError("The Grok agent sent invalid data."));
      }
    }
  }

  private stop(error: SafeDriverError): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.notifications.fail(error);
  }
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
  "GROK_HOME",
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
  environment.GROK_DISABLE_AUTOUPDATER = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function defaultProcessFactory(options: GrokSpawnOptions): GrokChildProcess {
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
    throw new SafeDriverError("The Grok workspace is not available.");
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
    throw new SafeDriverError("The Grok run has no transcript input.");
  }
  return `OpenBot transcript:\n\n${parts.join("\n\n")}`;
}

function resultObject(result: unknown): JsonObject {
  if (!isObject(result)) {
    throw new SafeDriverError("The Grok agent returned invalid data.");
  }
  return result;
}

function sessionIdFrom(result: unknown): string {
  const sessionId = resultObject(result).sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new SafeDriverError("The Grok agent returned invalid data.");
  }
  return sessionId;
}

function eventFor(message: JsonObject): DriverEvent | undefined {
  if (message.method !== "session/update") return undefined;
  const params = isObject(message.params) ? message.params : undefined;
  const update = params && isObject(params.update) ? params.update : undefined;
  if (!update || typeof update.sessionUpdate !== "string") return undefined;
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = isObject(update.content) ? update.content : undefined;
    if (
      content?.type === "text" &&
      typeof content.text === "string" &&
      content.text
    ) {
      return { type: "text", delta: content.text };
    }
    return undefined;
  }
  if (update.sessionUpdate === "tool_call") {
    return { type: "activity", message: "Native tool started" };
  }
  if (update.sessionUpdate === "tool_call_update") {
    const status = update.status;
    const safeStatus =
      status === "completed" || status === "failed" || status === "in_progress"
        ? status
        : undefined;
    return {
      type: "activity",
      message:
        safeStatus === "completed"
          ? "Native tool completed"
          : safeStatus === "failed"
            ? "Native tool failed"
            : "Native tool updated",
      ...(safeStatus ? { data: { status: safeStatus } } : {}),
    };
  }
  if (update.sessionUpdate === "plan") {
    return { type: "activity", message: "Plan updated" };
  }
  return undefined;
}

export interface GrokDriverOptions {
  processFactory?: GrokProcessFactory;
  binary?: string;
  version?: string;
  environment?: Record<string, string | undefined>;
  authTimeoutMs?: number;
  sandboxProfile?: string;
}

export class GrokDriver implements AgentDriver {
  readonly provider = "grok";
  readonly version: string;
  private readonly processFactory: GrokProcessFactory;
  private readonly binary: string;
  private readonly environment: Record<string, string>;
  private readonly authTimeoutMs: number;
  private readonly sandboxProfile: string;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: GrokDriverOptions = {}) {
    this.processFactory = options.processFactory ?? defaultProcessFactory;
    this.binary = options.binary ?? "grok";
    this.version = options.version ?? process.env.GROK_VERSION ?? "unknown";
    this.environment = safeEnvironment(options.environment ?? process.env);
    this.authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.sandboxProfile = options.sandboxProfile ?? "strict";
  }

  async isAuthReady(): Promise<boolean> {
    let child: GrokChildProcess;
    try {
      child = this.processFactory({
        command: [this.binary, "models"],
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
      timer = setTimeout(() => resolve(undefined), this.authTimeoutMs);
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
    if (active.sessionId) {
      active.connection.notify("session/cancel", {
        sessionId: active.sessionId,
      });
    }
    await active.connection.shutdown();
  }

  private async *execute(
    run: DriverRun,
    context: DriverRunContext,
    existingSessionId?: string,
  ): AsyncGenerator<DriverEvent> {
    const workspace = requiredWorkspace(run);
    if (this.active.has(run.runId)) {
      throw new SafeDriverError("The Grok run is already active.");
    }
    let child: GrokChildProcess;
    try {
      child = this.processFactory({
        command: [
          this.binary,
          "--no-subagents",
          "--sandbox",
          this.sandboxProfile,
          "agent",
          "--always-approve",
          "--no-leader",
          "stdio",
        ],
        cwd: workspace,
        env: this.environment,
      });
    } catch {
      throw new SafeDriverError("The Grok agent could not start.");
    }
    const connection = new GrokConnection(child);
    const active: ActiveRun = { connection };
    this.active.set(run.runId, active);
    const onAbort = () => void this.cancel(run.runId);
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "openbot_subscription_gateway",
          title: "OpenBot Subscription Gateway",
          version: "0.1.0",
        },
      });
      const sessionResult = existingSessionId
        ? await connection.request("session/load", {
            sessionId: existingSessionId,
            cwd: workspace,
            mcpServers: [],
            _meta: { yoloMode: true },
          })
        : await connection.request("session/new", {
            cwd: workspace,
            mcpServers: [],
            _meta: { yoloMode: true },
          });
      const sessionId = existingSessionId ?? sessionIdFrom(sessionResult);
      active.sessionId = sessionId;
      if (!existingSessionId) yield { type: "session", sessionId };

      const terminal = connection
        .request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: transcript(run) }],
          },
          true,
        )
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      for await (const message of connection.events()) {
        if (message.method === "$request/completed") {
          const outcome = await terminal;
          if ("error" in outcome) throw outcome.error;
          const result = resultObject(outcome.result);
          if (typeof result.stopReason !== "string") {
            throw new SafeDriverError("The Grok agent returned invalid data.");
          }
          return;
        }
        const event = eventFor(message);
        if (event) yield event;
      }
      throw new SafeDriverError("The Grok agent stopped early.");
    } catch (error) {
      if (context.signal.aborted) return;
      if (error instanceof SafeDriverError) throw error;
      throw new SafeDriverError("The Grok run failed.");
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (this.active.get(run.runId) === active) this.active.delete(run.runId);
      await connection.shutdown();
    }
  }
}
