const TEXT_EVENT_STREAM = "text/event-stream; charset=utf-8";
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_MAX_INPUT_CHARS = 8_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 1;

export type HermesProfileRosterEntry = {
  /** The Hermes profile ID. It is configuration, never read from an AG-UI body. */
  id: string;
  /** Display metadata for the OpenBot operator; not sent to Hermes. */
  displayName: string;
};

export type HermesBridgeConfig = {
  authToken: string;
  cliPath: string;
  roster: HermesProfileRosterEntry[];
  maxInputChars?: number;
  maxOutputChars?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
};

export type HermesCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface HermesCommandRunner {
  run(args: string[], prompt: string, timeoutMs: number): Promise<HermesCommandResult>;
}

type AgentInput = {
  threadId?: unknown;
  runId?: unknown;
  messages?: unknown;
  tools?: unknown;
};

type UserMessage = {
  role?: unknown;
  content?: unknown;
};

type ReadyResult =
  | { ok: true; profiles: string[] }
  | { ok: false; profiles: string[]; error: string };

export type HermesBridge = {
  ready(): Promise<ReadyResult>;
  handle(request: Request): Promise<Response>;
};

export function createHermesBridge(
  rawConfig: HermesBridgeConfig,
  runner: HermesCommandRunner = new BunHermesCommandRunner(rawConfig.cliPath),
): HermesBridge {
  const config = normalizeConfig(rawConfig);
  const byId = new Map(config.roster.map((entry) => [entry.id, entry]));
  let readiness: Promise<ReadyResult> | undefined;
  let verifiedProfiles = new Set<string>();
  let activeRequests = 0;

  async function ready(): Promise<ReadyResult> {
    if (!readiness) {
      readiness = verifyRoster(config, runner).then((result) => {
        if (result.ok) verifiedProfiles = new Set(result.profiles);
        return result;
      });
    }
    return readiness;
  }

  async function handle(request: Request): Promise<Response> {
    if (!matchesToken(config.authToken, request.headers.get("x-openbot-agent-token") ?? "")) {
      return jsonError("Unauthorized.", 401);
    }

    const url = new URL(request.url);
    const profileId = profileIdFromPath(url.pathname);
    const profile = profileId ? byId.get(profileId) : undefined;
    if (!profile) return jsonError("Not found.", 404);

    const readyResult = await ready();
    if (!readyResult.ok || !verifiedProfiles.has(profile.id)) {
      return jsonError("Hermes bridge is not ready.", 503);
    }

    if (request.method !== "POST") return jsonError("Method not allowed.", 405);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
      return jsonError("Content-Type must be application/json.", 415);
    }
    if (activeRequests >= config.maxConcurrent) {
      return jsonError("Hermes bridge is busy.", 429);
    }

    const rawBody = await readBoundedBody(request, config.maxInputChars);
    if (rawBody === null) return jsonError("Request body is too large.", 413);

    let input: AgentInput;
    try {
      input = JSON.parse(rawBody) as AgentInput;
    } catch {
      return jsonError("Request body must be valid JSON.", 400);
    }

    const prompt = promptFromInput(input, config.maxInputChars);
    if (prompt === null) return jsonError("A text user message is required.", 400);
    if (Array.isArray(input.tools) && input.tools.length > 0) {
      return jsonError("Hermes bridge tools are disabled.", 403);
    }

    const threadId = stringId(input.threadId);
    const runId = stringId(input.runId);
    if (!threadId || !runId) return jsonError("threadId and runId are required.", 400);

    activeRequests += 1;
    try {
      let result: HermesCommandResult;
      try {
        result = await withTimeout(
          runner.run(hermesChatArgs(profile.id), prompt, config.timeoutMs),
          config.timeoutMs,
        );
      } catch (error) {
        if (error instanceof HermesTimeoutError) {
          return jsonError("Hermes request timed out.", 504);
        }
        return jsonError("Hermes profile did not answer.", 502);
      }
      if (result.exitCode !== 0) return jsonError("Hermes profile did not answer.", 502);

      const text = normalizeOutput(result.stdout, config.maxOutputChars, config.authToken);
      if (!text) return jsonError("Hermes profile returned no text.", 502);
      return agUiTextResponse(threadId, runId, text);
    } finally {
      activeRequests -= 1;
    }
  }

  return { ready, handle };
}

class HermesTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HermesTimeoutError("Hermes command timed out.")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function hermesProfileShowArgs(profileId: string): string[] {
  return ["-p", profileId, "profile", "show", profileId];
}

export function hermesChatArgs(profileId: string): string[] {
  return [
    "-p",
    profileId,
    "chat",
    "--toolsets",
    "safe",
    "--quiet",
    "--query-file",
    "-",
    "--ignore-rules",
    "--source",
    "tool",
    "--max-turns",
    "1",
  ];
}

function normalizeConfig(raw: HermesBridgeConfig): Required<HermesBridgeConfig> {
  if (!raw.authToken.trim()) throw new Error("Hermes bridge auth token is required.");
  if (!raw.cliPath.trim()) throw new Error("Hermes CLI path is required.");
  if (raw.roster.length === 0) throw new Error("Hermes profile roster is required.");

  const ids = new Set<string>();
  for (const entry of raw.roster) {
    if (!PROFILE_ID.test(entry.id)) throw new Error("Hermes profile IDs must be safe slugs.");
    if (ids.has(entry.id)) throw new Error("Hermes profile IDs must be unique.");
    if (!entry.displayName.trim()) throw new Error("Hermes profile display names are required.");
    ids.add(entry.id);
  }

  return {
    authToken: raw.authToken,
    cliPath: raw.cliPath,
    roster: raw.roster,
    maxInputChars: raw.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
    maxOutputChars: raw.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrent: raw.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
  };
}

async function verifyRoster(
  config: Required<HermesBridgeConfig>,
  runner: HermesCommandRunner,
): Promise<ReadyResult> {
  const profiles: string[] = [];
  for (const entry of config.roster) {
    try {
      const result = await runner.run(
        hermesProfileShowArgs(entry.id),
        "",
        config.timeoutMs,
      );
      if (result.exitCode !== 0) {
        return { ok: false, profiles: [], error: "Configured Hermes profile is unavailable." };
      }
      profiles.push(entry.id);
    } catch {
      return { ok: false, profiles: [], error: "Hermes CLI readiness check failed." };
    }
  }
  return { ok: true, profiles };
}

function profileIdFromPath(pathname: string): string | null {
  const match = /^\/ag-ui\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return PROFILE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function matchesToken(expected: string, offered: string): boolean {
  const normalized = offered.trim();
  if (normalized.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ normalized.charCodeAt(index);
  }
  return difference === 0;
}

async function readBoundedBody(request: Request, maxChars: number): Promise<string | null> {
  const body = await request.text();
  return body.length <= maxChars ? body : null;
}

function promptFromInput(input: AgentInput, maxInputChars: number): string | null {
  if (!Array.isArray(input.messages)) return null;
  const messages = input.messages as UserMessage[];
  const userMessage = [...messages]
    .reverse()
    .find((message) => message?.role === "user" && typeof message.content === "string");
  if (!userMessage || typeof userMessage.content !== "string") return null;
  const content = userMessage.content.trim();
  if (!content || content.length > maxInputChars) return null;
  return [
    "Answer the user with plain text only.",
    "Do not call tools or include session metadata.",
    "User request:",
    content,
  ].join("\n\n");
}

function stringId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function normalizeOutput(raw: string, maxChars: number, authToken: string): string {
  const withoutSessionLines = raw
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => !/^\s*session(?:_id| id)?\s*[:=]/i.test(line))
    .join("\n");
  const redacted = withoutSessionLines.replaceAll(authToken, "[REDACTED]");
  return redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maxChars);
}

function agUiTextResponse(threadId: string, runId: string, text: string): Response {
  const messageId = `msg_${runId}`;
  const events = [
    ["RUN_STARTED", { type: "RUN_STARTED", threadId, runId }],
    ["TEXT_MESSAGE_START", { type: "TEXT_MESSAGE_START", messageId, role: "assistant" }],
    ["TEXT_MESSAGE_CONTENT", { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text }],
    ["TEXT_MESSAGE_END", { type: "TEXT_MESSAGE_END", messageId }],
    ["RUN_FINISHED", { type: "RUN_FINISHED", threadId, runId }],
  ] as const;
  const body = events
    .map(([type, event]) => `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    headers: {
      "content-type": TEXT_EVENT_STREAM,
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

class BunHermesCommandRunner implements HermesCommandRunner {
  constructor(private readonly cliPath: string) {}

  async run(args: string[], prompt: string, timeoutMs: number): Promise<HermesCommandResult> {
    const child = Bun.spawn([this.cliPath, ...args], {
      env: hermesChildEnvironment(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    try {
      if (prompt) {
        child.stdin.write(prompt);
      }
      child.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function hermesChildEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  for (const name of ["HERMES_HOME", "HERMES_REAL_HOME"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
