/**
 * The engine's HTTP surface, as agent-langgraph-agui serves it: AG-UI over SSE at `/`, `/health`
 * without a token, everything else behind `x-openbot-agent-token` = `MANAGED_AGENT_TOKEN`, compared
 * in constant time and refused when the deployment set none.
 */
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import type { Env } from "./models.ts";
import { type RunOptions, runAgent } from "./run.ts";

export const TOKEN_HEADER = "x-openbot-agent-token";

/** The largest request body taken: a long thread with images, well short of a memory problem. */
const MOST_BODY_BYTES = 64 * 1024 * 1024;

function sameToken(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MOST_BODY_BYTES)
      throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type ServerOptions = Omit<RunOptions, "emit" | "signal"> & { env?: Env };

/**
 * The models a signed-in ChatGPT plan offers, from the plan's own harness, for the server's model
 * picker. Only an engine on a plan has one, as on agent-langgraph-agui.
 */
async function planModels(
  env: Env,
  response: ServerResponse,
  fetcher: typeof fetch,
) {
  const url = env.CHATGPT_PLAN_HARNESS_URL?.trim();
  if (!url)
    return json(response, 404, {
      error: "This Bot is not signed in to a ChatGPT plan.",
    });
  const token =
    env.CHATGPT_PLAN_HARNESS_TOKEN?.trim() ||
    env.MANAGED_AGENT_TOKEN?.trim() ||
    "";
  try {
    const answer = await fetcher(`${url.replace(/\/$/, "")}/models`, {
      headers: { [TOKEN_HEADER]: token },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    response.writeHead(answer.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(await answer.text());
  } catch {
    json(response, 502, {
      error: "The ChatGPT plan's model list could not be read.",
    });
  }
}

export function createEngine(options: ServerOptions = {}): Server {
  const env = options.env ?? process.env;
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://engine").pathname;
    if (path === "/health" && request.method === "GET") {
      return json(response, 200, { ok: true, harness: "langgraph-ts" });
    }
    const expected = env.MANAGED_AGENT_TOKEN?.trim() ?? "";
    const offered = String(request.headers[TOKEN_HEADER] ?? "").trim();
    if (!expected || !sameToken(offered, expected))
      return json(response, 401, { error: "unauthorised" });

    if (path === "/models" && request.method === "GET")
      return planModels(env, response, options.fetch ?? fetch);
    if (path !== "/" || request.method !== "POST")
      return json(response, 404, { error: "not found" });

    let input: RunAgentInput;
    try {
      const parsed = RunAgentInputSchema.safeParse(
        JSON.parse(await readBody(request)),
      );
      if (!parsed.success)
        return json(response, 422, {
          error: "The run is not a valid AG-UI RunAgentInput.",
        });
      input = parsed.data;
    } catch (error) {
      const status = (error as { status?: number }).status === 413 ? 413 : 400;
      return json(response, status, {
        error:
          status === 413 ? "The run is too large." : "The run is not JSON.",
      });
    }

    const encoder = new EventEncoder({
      accept: String(request.headers.accept ?? "text/event-stream"),
    });
    response.writeHead(200, {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // The caller going away stops the run: its model calls and its tool callbacks.
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const emit = (event: BaseEvent) => {
      if (!response.writableEnded) response.write(encoder.encode(event));
    };
    await runAgent(input, { ...options, env, emit, signal: controller.signal });
    response.end();
  });
}
