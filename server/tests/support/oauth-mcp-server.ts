import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/**
 * A real MCP server that signs people in with OAuth, on this machine's loopback address, for the
 * tests and the end-to-end run of "add an MCP server by URL".
 *
 * It follows the MCP authorization spec the way a hosted vendor does, with nothing stubbed between
 * OpenBot and it: a 401 with a `WWW-Authenticate` challenge naming its protected resource metadata
 * (RFC 9728), authorization server metadata (RFC 8414) with `iss` on the redirect (RFC 9207),
 * dynamic client registration (RFC 7591), PKCE S256 checked at the token endpoint, the `resource`
 * parameter (RFC 8707) checked on both legs, refresh with rotation, and Streamable HTTP served by the
 * MCP SDK's own server. The consent page is a real page with an Allow button; `approve=1` on the
 * authorize address is the same press, for a test with no browser.
 */

export type OAuthMcpServer = {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The MCP endpoint, `<origin>/mcp`. */
  url: string;
  /** Every note `save_note` was called with, in order. */
  notes: string[];
  /** Every registered client, by id. */
  clients: Map<string, { redirectUris: string[] }>;
  /** Access tokens issued, so a test can expire one. */
  accessTokens: Map<string, { expiresAt: number; user: string }>;
  stop(): void;
};

type PendingCode = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  expiresAt: number;
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const token = () => randomBytes(24).toString("base64url");

export function startOAuthMcpServer(
  options: {
    port?: number;
    title?: string;
    accessTtlSeconds?: number;
    /** Answer MCP with no sign-in at all, as a public server does. */
    open?: boolean;
  } = {},
): OAuthMcpServer {
  const title = options.title ?? "Notes Test Server";
  const accessTtl = options.accessTtlSeconds ?? 3600;
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, { expiresAt: number; user: string }>();
  const refreshTokens = new Map<string, { clientId: string; user: string }>();
  const notes: string[] = [];
  let origin = "";

  const resourceUrl = () => `${origin}/mcp`;
  const metadataUrl = () =>
    `${origin}/.well-known/oauth-protected-resource/mcp`;

  const issue = (clientId: string, user: string) => {
    const access = token();
    const refresh = token();
    accessTokens.set(access, {
      expiresAt: Date.now() + accessTtl * 1000,
      user,
    });
    refreshTokens.set(refresh, { clientId, user });
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_token: refresh,
      scope: "notes:read notes:write",
    });
  };

  function mcpServer(user: string): McpServer {
    const server = new McpServer({ name: title, version: "1.0.0" });
    server.registerTool(
      "save_note",
      {
        description: "Save a short note to the signed-in person's notebook.",
        inputSchema: { text: z.string().describe("The note to save.") },
      },
      async ({ text }) => {
        notes.push(text);
        return {
          content: [
            {
              type: "text",
              text: `Saved note #${notes.length} for ${user}: ${text}`,
            },
          ],
        };
      },
    );
    server.registerTool(
      "list_notes",
      {
        description: "List every note in the signed-in person's notebook.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: [
          {
            type: "text",
            text:
              notes.length === 0
                ? `${user} has no notes yet.`
                : notes.map((note, i) => `${i + 1}. ${note}`).join("\n"),
          },
        ],
      }),
    );
    return server;
  }

  function consentPage(url: URL): Response {
    const approve = new URL(url);
    approve.searchParams.set("approve", "1");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}: sign in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;max-width:360px}
h1{font-size:20px;margin:0 0 8px}p{color:#52525b;font-size:14px;line-height:1.5}
a{display:inline-block;margin-top:16px;background:#18181b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px}</style>
</head><body><main><h1>${title}</h1><p>OpenBot wants to read and save notes in your notebook as you.</p>
<p>Signed in as <b>test-person</b>.</p><a id="allow" href="${approve.toString()}">Allow</a></main></body></html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (
        path === "/.well-known/oauth-protected-resource/mcp" ||
        path === "/.well-known/oauth-protected-resource"
      ) {
        return json({
          resource: resourceUrl(),
          authorization_servers: [origin],
          scopes_supported: ["notes:read", "notes:write"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["notes:read", "notes:write"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (path === "/register" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          redirect_uris?: string[];
          client_name?: string;
        } | null;
        if (!body?.redirect_uris?.length) {
          return json({ error: "invalid_redirect_uri" }, 400);
        }
        const clientId = `client-${token()}`;
        clients.set(clientId, { redirectUris: body.redirect_uris });
        return json(
          {
            client_id: clientId,
            client_name: body.client_name,
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
          201,
        );
      }
      if (path === "/authorize") {
        const q = url.searchParams;
        const client = clients.get(q.get("client_id") ?? "");
        const redirectUri = q.get("redirect_uri") ?? "";
        if (!client?.redirectUris.includes(redirectUri)) {
          return new Response("Unknown client or redirect URI.", {
            status: 400,
          });
        }
        if (
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !q.get("code_challenge") ||
          q.get("resource") !== resourceUrl()
        ) {
          return new Response(
            "This sign-in request is missing PKCE or the resource.",
            { status: 400 },
          );
        }
        if (q.get("approve") !== "1") return consentPage(url);
        const code = token();
        codes.set(code, {
          clientId: q.get("client_id") ?? "",
          redirectUri,
          challenge: q.get("code_challenge") ?? "",
          resource: q.get("resource") ?? "",
          expiresAt: Date.now() + 60_000,
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        back.searchParams.set("iss", origin);
        return Response.redirect(back.toString(), 302);
      }
      if (path === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const clientId = form.get("client_id") ?? "";
        if (!clients.has(clientId)) {
          return json({ error: "invalid_client" }, 401);
        }
        if (form.get("grant_type") === "authorization_code") {
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (
            !pending ||
            pending.expiresAt < Date.now() ||
            pending.clientId !== clientId ||
            pending.redirectUri !== form.get("redirect_uri") ||
            pending.challenge !== challenge ||
            pending.resource !== form.get("resource")
          ) {
            return json({ error: "invalid_grant" }, 400);
          }
          return issue(clientId, "test-person");
        }
        if (form.get("grant_type") === "refresh_token") {
          const held = refreshTokens.get(form.get("refresh_token") ?? "");
          refreshTokens.delete(form.get("refresh_token") ?? "");
          if (!held || held.clientId !== clientId) {
            return json({ error: "invalid_grant" }, 400);
          }
          return issue(clientId, held.user);
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      if (path === "/mcp") {
        const bearer = request.headers.get("authorization") ?? "";
        const access = options.open
          ? { expiresAt: Number.POSITIVE_INFINITY, user: "anyone" }
          : accessTokens.get(bearer.replace(/^Bearer\s+/i, ""));
        if (!access || access.expiresAt < Date.now()) {
          return json({ error: "invalid_token" }, 401, {
            "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl()}", scope="notes:read notes:write"`,
          });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcpServer(access.user).connect(transport);
        return transport.handleRequest(request);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    url: resourceUrl(),
    notes,
    clients,
    accessTokens,
    stop: () => server.stop(true),
  };
}

// Run on its own for the end-to-end check: `bun tests/support/oauth-mcp-server.ts [port]`.
if (import.meta.main) {
  const port = Number(process.argv[2] ?? 0) || 0;
  const running = startOAuthMcpServer({ port });
  console.log(`OAuth MCP test server: ${running.url}`);
}
