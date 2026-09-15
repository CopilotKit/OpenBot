import { isAbsolute } from "node:path";
import { constants } from "node:os";
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

export interface ClaudeChildProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number): unknown;
}

export interface ClaudeSpawnOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export type ClaudeProcessFactory = (
  options: ClaudeSpawnOptions,
) => ClaudeChildProcess;

interface ActiveRun {
  child: ClaudeChildProcess;
  cancelled: boolean;
  stopPromise?: Promise<void>;
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
  "CLAUDE_CONFIG_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_NAMES.has(name)) {
      environment[name] = value;
    }
  }
  environment.CLAUDE_CODE_DISABLE_AUTO_UPDATER = "1";
  environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  return environment;
}

async function* jsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<JsonObject> {
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
        if (line) {
          const value: unknown = JSON.parse(line);
          if (!isObject(value)) throw new Error("Invalid stream record.");
          yield value;
        }
      }
    }
    buffered += decoder.decode();
    const finalLine = buffered.trim();
    if (finalLine) {
      const value: unknown = JSON.parse(finalLine);
      if (!isObject(value)) throw new Error("Invalid stream record.");
      yield value;
    }
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

function defaultProcessFactory(
  options: ClaudeSpawnOptions,
): ClaudeChildProcess {
  const child = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  };
}

function requiredWorkspace(run: DriverRun): string {
  if (!run.workspacePath || !isAbsolute(run.workspacePath)) {
    throw new SafeDriverError("The Claude workspace is not available.");
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
    throw new SafeDriverError("The Claude run has no transcript input.");
  }
  return `OpenBot transcript:\n\n${parts.join("\n\n")}`;
}

function toolName(value: unknown): string {
  if (typeof value !== "string") return "Native tool";
  const known = new Set([
    "Agent",
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "NotebookEdit",
    "Read",
    "Task",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
  ]);
  return known.has(value) ? value : "Native tool";
}

function assistantActivity(record: JsonObject): DriverEvent | undefined {
  const message = isObject(record.message) ? record.message : undefined;
  const content =
    message && Array.isArray(message.content) ? message.content : [];
  const use = content.find(
    (item): item is JsonObject => isObject(item) && item.type === "tool_use",
  );
  if (!use) return undefined;
  const name = toolName(use.name);
  return {
    type: "activity",
    message: `${name} started`,
    data: { nativeTool: name },
  };
}

function toolResultActivity(record: JsonObject): DriverEvent | undefined {
  const message = isObject(record.message) ? record.message : undefined;
  const content =
    message && Array.isArray(message.content) ? message.content : [];
  const result = content.find(
    (item): item is JsonObject => isObject(item) && item.type === "tool_result",
  );
  if (!result) return undefined;
  return {
    type: "activity",
    message:
      result.is_error === true ? "Native tool failed" : "Native tool completed",
  };
}

async function exitedWithin(
  child: ClaudeChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = child.exited.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

export interface ClaudeDriverOptions {
  processFactory?: ClaudeProcessFactory;
  binary?: string;
  version?: string;
  environment?: Record<string, string | undefined>;
  interruptTimeoutMs?: number;
  terminateTimeoutMs?: number;
  authTimeoutMs?: number;
}

export class ClaudeDriver implements AgentDriver {
  readonly provider = "claude";
  readonly version: string;
  private readonly processFactory: ClaudeProcessFactory;
  private readonly binary: string;
  private readonly environment: Record<string, string>;
  private readonly interruptTimeoutMs: number;
  private readonly terminateTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: ClaudeDriverOptions = {}) {
    this.processFactory = options.processFactory ?? defaultProcessFactory;
    this.binary = options.binary ?? "claude";
    this.version = options.version ?? process.env.CLAUDE_VERSION ?? "unknown";
    this.environment = safeEnvironment(options.environment ?? process.env);
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 3_000;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? 2_000;
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
  }

  async isAuthReady(): Promise<boolean> {
    let child: ClaudeChildProcess;
    try {
      child = this.processFactory({
        command: [this.binary, "auth", "status"],
        cwd: process.cwd(),
        env: this.environment,
      });
    } catch {
      return false;
    }
    void drain(child.stdout);
    void drain(child.stderr);
    if (!(await exitedWithin(child, this.authTimeoutMs))) {
      try {
        child.kill(constants.signals.SIGKILL);
      } catch {}
      return false;
    }
    return (await child.exited) === 0;
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
    active.cancelled = true;
    await this.stopProcess(active);
  }

  private stopProcess(active: ActiveRun): Promise<void> {
    if (active.stopPromise) return active.stopPromise;
    active.stopPromise = (async () => {
      try {
        active.child.kill(constants.signals.SIGINT);
      } catch {
        return;
      }
      if (await exitedWithin(active.child, this.interruptTimeoutMs)) return;
      try {
        active.child.kill(constants.signals.SIGTERM);
      } catch {
        return;
      }
      if (await exitedWithin(active.child, this.terminateTimeoutMs)) return;
      try {
        active.child.kill(constants.signals.SIGKILL);
      } catch {}
      await exitedWithin(active.child, this.terminateTimeoutMs);
    })();
    return active.stopPromise;
  }

  private async *execute(
    run: DriverRun,
    context: DriverRunContext,
    sessionId?: string,
  ): AsyncGenerator<DriverEvent> {
    const workspace = requiredWorkspace(run);
    if (this.active.has(run.runId)) {
      throw new SafeDriverError("The Claude run is already active.");
    }
    const command = [
      this.binary,
      "-p",
      transcript(run),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "dontAsk",
      ...(sessionId ? ["--resume", sessionId] : []),
    ];
    let child: ClaudeChildProcess;
    try {
      child = this.processFactory({
        command,
        cwd: workspace,
        env: this.environment,
      });
    } catch {
      throw new SafeDriverError("The Claude CLI could not start.");
    }
    const active: ActiveRun = { child, cancelled: false };
    this.active.set(run.runId, active);
    void drain(child.stderr);
    const onAbort = () => void this.cancel(run.runId);
    context.signal.addEventListener("abort", onAbort, { once: true });
    let terminal = false;
    let initialized = false;

    try {
      try {
        for await (const record of jsonLines(child.stdout)) {
          if (record.type === "system" && record.subtype === "init") {
            initialized = true;
            if (!sessionId) {
              if (typeof record.session_id !== "string" || !record.session_id) {
                throw new SafeDriverError(
                  "The Claude CLI returned invalid data.",
                );
              }
              yield { type: "session", sessionId: record.session_id };
            }
            continue;
          }
          if (record.type === "stream_event") {
            const event = isObject(record.event) ? record.event : undefined;
            const delta =
              event && isObject(event.delta) ? event.delta : undefined;
            if (
              event?.type === "content_block_delta" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string" &&
              delta.text
            ) {
              yield { type: "text", delta: delta.text };
            }
            continue;
          }
          if (record.type === "assistant") {
            const activity = assistantActivity(record);
            if (activity) yield activity;
            continue;
          }
          if (record.type === "user") {
            const activity = toolResultActivity(record);
            if (activity) yield activity;
            continue;
          }
          if (record.type === "system" && record.subtype === "api_retry") {
            const isRateLimit =
              record.error === "rate_limit" || record.error_status === 429;
            yield {
              type: "activity",
              message: isRateLimit
                ? "Claude is retrying after a rate limit"
                : "Claude is retrying a provider request",
              data: {
                ...(typeof record.attempt === "number"
                  ? { attempt: record.attempt }
                  : {}),
                ...(typeof record.max_retries === "number"
                  ? { maxRetries: record.max_retries }
                  : {}),
              },
            };
            continue;
          }
          if (
            record.type === "system" &&
            (record.subtype === "hook_started" ||
              record.subtype === "permission_denial")
          ) {
            throw new SafeDriverError(
              "The Claude run requested permission beyond worker policy.",
            );
          }
          if (record.type === "result") {
            terminal = true;
            if (
              Array.isArray(record.permission_denials) &&
              record.permission_denials.length > 0
            ) {
              throw new SafeDriverError(
                "The Claude run requested permission beyond worker policy.",
              );
            }
            if (record.is_error === true || record.subtype !== "success") {
              throw new SafeDriverError("The Claude run failed.");
            }
            if (!initialized) {
              throw new SafeDriverError(
                "The Claude CLI returned invalid data.",
              );
            }
            return;
          }
        }
      } catch (error) {
        if (error instanceof SafeDriverError) throw error;
        if (active.cancelled || context.signal.aborted) return;
        throw new SafeDriverError("The Claude CLI sent invalid data.");
      }
      if (active.cancelled || context.signal.aborted) return;
      if (!terminal) throw new SafeDriverError("The Claude CLI stopped early.");
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (this.active.get(run.runId) === active) this.active.delete(run.runId);
      if (!terminal && !active.cancelled) await this.stopProcess(active);
    }
  }
}
