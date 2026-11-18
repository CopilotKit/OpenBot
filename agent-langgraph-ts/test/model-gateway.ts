/**
 * The server's model gateway as the live AI connection contract defines it, on 127.0.0.1.
 *
 *  - OpenAI wire: `POST /api/model-provider/v1/chat/completions`, `POST .../v1/responses`,
 *    `GET .../v1/models`. Anthropic wire: `POST /api/model-provider/anthropic/v1/messages`,
 *    `GET .../anthropic/v1/models`. Anything else is 404.
 *  - Auth: `Authorization: Bearer <t>` or `x-api-key: <t>`, `<t>` one of the run tokens it minted.
 *  - Per request: the connection as it stands now, the caller's auth headers stripped, the
 *    connection's key added, sent to the connection's upstream (never one the request names) with
 *    `redirect: "error"`, and the answer streamed back as it came.
 *  - A wire the connection can't serve: 409 with a plain sentence, in that wire's error shape, and
 *    `x-should-retry: false` so neither SDK asks again.
 *
 * The upstream is the fake provider by default. With `OPENBOT_LIVE_PROVIDERS=1` and the provider
 * keys in this test process's environment, it is the real provider: the engine still holds only
 * the run token, exactly as it does behind the real gateway.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type Provider = "openai" | "anthropic";
export type Upstream = { base: string; key: string };

export type GatewayRequest = {
  method: string;
  path: string;
  /** The wire the request was sent on. */
  wire: Provider;
  /** The connection that served it, or undefined when it was refused. */
  served?: Provider;
  /** How the caller authenticated: which header carried which token. */
  auth?: { header: "authorization" | "x-api-key"; token: string };
  status: number;
  /** What the upstream was sent, with the key standing in as "<key>". */
  upstream?: { url: string; headers: Record<string, string> };
  body: Record<string, unknown>;
};

export type Gateway = {
  /** `OPENBOT_MODEL_GATEWAY_URL` for an engine: the gateway's root. */
  url: string;
  requests: GatewayRequest[];
  /** Switch the organization's connection, as replaceAiConnection does. */
  connect: (provider: Provider) => void;
  /** Mint a run token the gateway accepts. */
  mint: (token: string) => void;
  close: () => Promise<void>;
};

const ROOT = "/api/model-provider";
const ROUTES: Record<string, { method: string; wire: Provider }> = {
  "/v1/chat/completions": { method: "POST", wire: "openai" },
  "/v1/responses": { method: "POST", wire: "openai" },
  "/v1/models": { method: "GET", wire: "openai" },
  "/anthropic/v1/messages": { method: "POST", wire: "anthropic" },
  "/anthropic/v1/models": { method: "GET", wire: "anthropic" },
};

/** Never forwarded: the caller's credentials and the hop's own headers. */
const DROPPED = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "keep-alive",
  "transfer-encoding",
]);

export const MISMATCH = {
  openai:
    "This OpenBot is connected to Anthropic, so it can't answer on OpenAI's API.",
  anthropic:
    "This OpenBot is connected to an OpenAI-compatible provider, so it can't answer on Anthropic's API.",
};

function errorBody(wire: Provider, message: string, type: string) {
  return wire === "anthropic"
    ? { type: "error", error: { type, message } }
    : { error: { message, type, code: null, param: null } };
}

function offeredToken(
  headers: IncomingHttpHeaders,
): GatewayRequest["auth"] | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ""));
  if (bearer?.[1]) return { header: "authorization", token: bearer[1].trim() };
  const key = String(headers["x-api-key"] ?? "").trim();
  if (key) return { header: "x-api-key", token: key };
  return undefined;
}

export async function modelGateway(
  upstreams: Record<Provider, Upstream>,
  first: Provider,
): Promise<Gateway> {
  let connection: Provider = first;
  const tokens = new Set<string>();
  const requests: GatewayRequest[] = [];

  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const path = new URL(request.url ?? "/", "http://gateway").pathname;
    const route = path.startsWith(ROOT)
      ? ROUTES[path.slice(ROOT.length)]
      : undefined;
    const method = request.method ?? "GET";
    const recorded: GatewayRequest = {
      method,
      path,
      wire: route?.wire ?? "openai",
      status: 0,
      body: raw.length ? JSON.parse(raw.toString("utf8")) : {},
    };
    requests.push(recorded);
    const answer = (status: number, body: unknown) => {
      recorded.status = status;
      response.writeHead(status, {
        "content-type": "application/json",
        ...(status === 409 ? { "x-should-retry": "false" } : {}),
      });
      response.end(JSON.stringify(body));
    };
    if (!route || route.method !== method)
      return answer(
        404,
        errorBody("openai", "Not a model gateway route.", "not_found_error"),
      );
    const auth = offeredToken(request.headers);
    if (!auth || !tokens.has(auth.token))
      return answer(
        401,
        errorBody(
          route.wire,
          "OpenBot's model gateway didn't accept this run's token.",
          "authentication_error",
        ),
      );
    recorded.auth = auth;
    // The connection as it stands for this request: a switch applies to the next one.
    const now = connection;
    if (route.wire !== now)
      return answer(
        409,
        errorBody(route.wire, MISMATCH[route.wire], "invalid_request_error"),
      );
    recorded.served = now;
    const upstream = upstreams[now];
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (DROPPED.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers["accept-encoding"] = "identity";
    const shown = { ...headers };
    if (now === "anthropic") {
      headers["x-api-key"] = upstream.key;
      shown["x-api-key"] = "<key>";
    } else {
      headers.authorization = `Bearer ${upstream.key}`;
      shown.authorization = "Bearer <key>";
    }
    const tail =
      now === "anthropic"
        ? path.slice(`${ROOT}/anthropic`.length)
        : path.slice(ROOT.length);
    const url = `${upstream.base.replace(/\/$/, "")}${tail}`;
    recorded.upstream = { url, headers: shown };
    let reply: Response;
    try {
      reply = await fetch(url, {
        method,
        headers,
        redirect: "error",
        ...(method === "POST" ? { body: raw } : {}),
      });
    } catch {
      return answer(
        502,
        errorBody(
          route.wire,
          "OpenBot couldn't reach the AI model.",
          "api_error",
        ),
      );
    }
    recorded.status = reply.status;
    const passed: Record<string, string> = {};
    for (const name of ["content-type", "request-id", "x-request-id"]) {
      const value = reply.headers.get(name);
      if (value) passed[name] = value;
    }
    response.writeHead(reply.status, passed);
    if (!reply.body) return response.end();
    Readable.fromWeb(reply.body as never).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${ROOT}`,
    requests,
    connect: (provider) => {
      connection = provider;
    },
    mint: (token) => {
      tokens.add(token);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Real providers behind the gateway, when this run asked for them and holds their keys. */
export function liveUpstreams(): Record<Provider, Upstream> | undefined {
  if (process.env.OPENBOT_LIVE_PROVIDERS !== "1") return undefined;
  const openai = process.env.OPENAI_API_KEY?.trim();
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  if (!openai || !anthropic)
    throw new Error(
      "OPENBOT_LIVE_PROVIDERS=1 needs OPENAI_API_KEY and ANTHROPIC_API_KEY in the test's environment.",
    );
  // Only the gateway holds them from here: an engine that reached for a key in the process's
  // environment (as the SDKs do when given none) finds nothing.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  return {
    openai: { base: "https://api.openai.com", key: openai },
    anthropic: { base: "https://api.anthropic.com", key: anthropic },
  };
}
