/** Drive the engine as the server does: a real HTTP AG-UI run against `createEngine`. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createEngine, type ServerOptions } from "../src/server.ts";

export const TOKEN = "engine-test-token";

export type Event = Record<string, unknown> & { type: string };

export function events(sse: string): Event[] {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);
}

export async function withEngine<T>(
  options: ServerOptions,
  body: (base: string) => Promise<T>,
): Promise<T> {
  const env = { MANAGED_AGENT_TOKEN: TOKEN, ...(options.env ?? {}) };
  const server = createEngine({
    ...options,
    env,
    log: options.log ?? { warn: () => {}, error: () => {} },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function run(
  base: string,
  input: Record<string, unknown>,
  token = TOKEN,
): Promise<{ status: number; events: Event[] }> {
  const response = await fetch(`${base}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-openbot-agent-token": token,
    },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  return { status: response.status, events: response.ok ? events(text) : [] };
}

/** A run in the shape the server sends: role, holdings, then the restored thread. */
export function conversation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [
      {
        id: "standing-role:test-bot",
        role: "system",
        content: "You are Test Bot. STANDING_ROLE_MARKER",
      },
      {
        id: "granted-tools:test-bot",
        role: "system",
        content: "You hold these tools: GRANTED_TOOLS_MARKER",
      },
      {
        id: "u1",
        role: "user",
        content: "Earlier question EARLIER_QUESTION_MARKER",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Earlier answer EARLIER_ANSWER_MARKER",
      },
      {
        id: "u2",
        role: "user",
        content: "Latest question LATEST_QUESTION_MARKER",
      },
    ],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

export const WEATHER_TOOL = {
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

export function types(list: Event[]): string[] {
  return list.map((event) => event.type);
}

export const quietLog = { warn: () => {}, error: () => {} };

/** A run's RUN_FINISHED, and the calls it names as left for the caller (AG-UI `pendingToolCallIds`). */
export function pendingOf(list: Event[]): string[] | undefined {
  const finished = list.find((event) => event.type === "RUN_FINISHED");
  const outcome = finished?.outcome as
    | { type?: string; pendingToolCallIds?: string[] }
    | undefined;
  return outcome?.pendingToolCallIds;
}

export type Tripwire = {
  url: string;
  /** Every request that reached it, by path. */
  hits: string[];
  close: () => Promise<void>;
};

/**
 * An HTTP server where OpenBot's old tool callback used to be. The engine is given its address and
 * a token, as a deployment from before the hand-back still sets them, and must never call it.
 */
export async function tripwire(): Promise<Tripwire> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "/");
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "the old callback answered" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/agent-tools/call`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** What a deployment from before the hand-back still sets: the old callback's address and token. */
export const oldCallbackEnv = (wire: Tripwire) => ({
  OPENBOT_TOOL_URL: wire.url,
  AGENT_TOOL_TOKEN: "old-callback-token",
});
