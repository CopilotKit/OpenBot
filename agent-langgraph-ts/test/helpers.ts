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

export type Callback = {
  url: string;
  calls: { name: string; args: unknown; run: unknown; token: unknown }[];
  close: () => Promise<void>;
};

/** The server's `/api/agent-tools/call`, answering every call it is sent. */
export async function toolCallback(
  answer = (name: string, _args?: unknown) => `result of ${name}`,
  delay = (_name: string) => 0,
): Promise<Callback> {
  const calls: Callback["calls"] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({
      name: body.name,
      args: body.args,
      run: body.run,
      token: request.headers["x-openbot-agent-token"],
    });
    await new Promise((resolve) => setTimeout(resolve, delay(body.name)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: answer(body.name, body.args) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/agent-tools/call`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
