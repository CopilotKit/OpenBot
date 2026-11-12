import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSIO_URL, E2E, PORTS } from "./config";

/**
 * A stand-in for Composio's API, so Browse apps, Add, Connect and Disconnect run end to end without
 * a real Composio project, a real account or the network. Started by Playwright as a web server
 * (see `composioStubServer` in composio.ts), before the stack, and OpenBot's Composio client is
 * built against it (`COMPOSIO_BASE_URL` in stack.ts).
 *
 * MATCHES THE REAL API, NOT A GUESS AT IT. Every endpoint here is one OpenBot was seen calling on
 * the real Composio (`backend.composio.dev`, API v3.1) through a logging proxy, and each answer has
 * the real answer's shape: the catalogue rows and tool rows in `e2e/stubs/composio-catalogue.json`
 * are real rows, verbatim, cut to eight apps and four tools each; the auth config, connected account
 * and link answers are built field for field on what the real API returned and what
 * `@composio/client` declares.
 *
 * THE PROVIDER'S SIGN-IN IS THE STUB'S TOO. A connect link points at `/link/<token>` here, a page
 * that stands for the app's consent screen. Allow marks the account ACTIVE and sends the browser to
 * the callback OpenBot gave, with `status=success`, as Composio's hosted page does; Cancel sends it
 * back with `status=failed`. No third-party sign-in is ever started.
 *
 * STRICT, LIKE AIMOCK'S REPLAY. A request this stub has no answer for is refused with a 501 and kept
 * in the journal (`GET /__stub/journal`), and a journey that reads the journal fails on it, naming
 * the request. State lives in memory for one run, which is one fresh stack.
 */

type Toolkit = {
  slug: string;
  name: string;
  auth_schemes: string[];
  composio_managed_auth_schemes: string[];
  meta: { logo?: string } & Record<string, unknown>;
} & Record<string, unknown>;

type Seed = { toolkits: Toolkit[]; tools: Record<string, unknown[]> };

type AuthConfig = {
  id: string;
  uuid: string;
  name: string;
  toolkit: string;
  auth_scheme: string;
  status: "ENABLED" | "DISABLED";
  created_at: string;
};

type Account = {
  id: string;
  auth_config_id: string;
  user_id: string;
  toolkit: string;
  status: "INITIATED" | "ACTIVE" | "FAILED";
  callback_url: string;
  link_token: string;
  created_at: string;
  updated_at: string;
};

type JournalEntry = {
  method: string;
  path: string;
  status: number;
  handled: boolean;
};

const seed = JSON.parse(
  readFileSync(join(E2E, "stubs", "composio-catalogue.json"), "utf8"),
) as Seed;

const authConfigs: AuthConfig[] = [];
const accounts: Account[] = [];
const journal: JournalEntry[] = [];
let counter = 0;

/** Composio's ids are a prefix and twelve characters; these are the same, and say what made them. */
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_e2e${String(counter).padStart(9, "0")}`;
}

function now(): string {
  return new Date().toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Composio's own error envelope, for a record that isn't there. */
function notFound(what: string): Response {
  return json(
    {
      error: {
        message: `${what} not found`,
        code: 404,
        slug: "NotFound",
        status: 404,
        request_id: id("req"),
      },
    },
    404,
  );
}

/** A list answer, one page, as every v3.1 list endpoint answers it. */
function page(items: unknown[]): Record<string, unknown> {
  return {
    items,
    next_cursor: null,
    total_pages: 1,
    current_page: 1,
    total_items: items.length,
  };
}

function toolkit(slug: string): Toolkit | undefined {
  return seed.toolkits.find((entry) => entry.slug === slug);
}

/** An auth config row, in the shape `GET /api/v3.1/auth_configs` answered for a managed one. */
function authConfigRow(config: AuthConfig): Record<string, unknown> {
  return {
    id: config.id,
    uuid: config.uuid,
    name: config.name,
    auth_scheme: config.auth_scheme,
    is_composio_managed: true,
    credentials: {
      client_id: "REDACTED",
      client_secret: "REDACTED",
      scopes: [],
      oauth_redirect_uri: "https://backend.composio.dev/api/v1/auth-apps/add",
    },
    created_by: "openbot-e2e",
    created_at: config.created_at,
    last_updated_at: config.created_at,
    status: config.status,
    toolkit: {
      slug: config.toolkit,
      logo: toolkit(config.toolkit)?.meta.logo ?? "",
    },
    no_of_connections: accounts.filter(
      (account) =>
        account.auth_config_id === config.id && account.status === "ACTIVE",
    ).length,
    tool_access_config: {
      tools_for_connected_account_creation: [],
      tools_available_for_execution: [],
    },
    is_enabled_for_tool_router: false,
    type: "default",
  };
}

/** A connected account row, in the shape `@composio/client` declares for the list and retrieve. */
function accountRow(account: Account): Record<string, unknown> {
  const config = authConfigs.find((row) => row.id === account.auth_config_id);
  const scheme = config?.auth_scheme ?? "OAUTH2";
  const val =
    account.status === "ACTIVE"
      ? {
          status: "ACTIVE",
          access_token: "openbot-e2e-stub-token",
          token_type: "Bearer",
        }
      : {
          status: account.status,
          redirectUrl: `${COMPOSIO_URL}/link/${account.link_token}`,
          callbackUrl: account.callback_url,
        };
  return {
    id: account.id,
    alias: null,
    auth_config: {
      id: account.auth_config_id,
      auth_scheme: scheme,
      is_composio_managed: true,
      is_disabled: false,
    },
    created_at: account.created_at,
    updated_at: account.updated_at,
    data: val,
    is_disabled: false,
    state: { authScheme: scheme, val },
    status: account.status,
    status_reason: null,
    toolkit: { slug: account.toolkit },
    user_id: account.user_id,
    word_id: null,
    experimental: { account_type: "PRIVATE" },
  };
}

/** A query value that may be repeated or comma-separated, as the SDK sends arrays. */
function many(query: URLSearchParams, name: string): string[] {
  return query
    .getAll(name)
    .flatMap((value) => value.split(","))
    .filter(Boolean);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The app's consent screen, played by the stub. */
function consentPage(account: Account): Response {
  const name = toolkit(account.toolkit)?.name ?? account.toolkit;
  const action = `/link/${account.link_token}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in to ${escapeHtml(name)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto;">
<main>
<h1>Sign in to ${escapeHtml(name)}</h1>
<p>OpenBot's end-to-end stand-in for ${escapeHtml(name)}'s consent screen. Nothing here reaches ${escapeHtml(name)}.</p>
<form method="post" action="${action}">
<button name="decision" value="allow" type="submit">Allow</button>
<button name="decision" value="cancel" type="submit">Cancel</button>
</form>
</main>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function route(request: Request, url: URL): Promise<Response | null> {
  const { pathname: path, searchParams: query } = url;
  const method = request.method;

  if (method === "GET" && path === "/__stub/health") return json({ ok: true });

  // The consent screen and its answer.
  const link = /^\/link\/([^/]+)$/.exec(path);
  if (link) {
    const account = accounts.find((row) => row.link_token === link[1]);
    if (!account) return notFound("Link");
    if (method === "GET") return consentPage(account);
    if (method === "POST") {
      const form = await request.formData();
      const allowed = form.get("decision") === "allow";
      account.status = allowed ? "ACTIVE" : "FAILED";
      account.updated_at = now();
      const back = new URL(account.callback_url);
      back.searchParams.set("status", allowed ? "success" : "failed");
      back.searchParams.set("connected_account_id", account.id);
      return Response.redirect(back.toString(), 302);
    }
  }

  // Everything else is the API, under v3.1 (and v3, which the SDK still names for a few calls).
  const api = /^\/api\/v3(?:\.1)?(\/.*)$/.exec(path)?.[1];
  if (!api) return null;

  if (method === "GET" && api === "/toolkits") return json(page(seed.toolkits));
  const toolkitRead = /^\/toolkits\/([^/]+)$/.exec(api);
  if (method === "GET" && toolkitRead) {
    const found = toolkit(toolkitRead[1]);
    return found ? json(found) : notFound("Toolkit");
  }

  if (method === "GET" && api === "/tools") {
    const slugs = many(query, "toolkit_slug");
    const tools = slugs.flatMap((slug) => seed.tools[slug] ?? []);
    return json(page(tools));
  }
  const toolRead = /^\/tools\/([^/]+)$/.exec(api);
  if (method === "GET" && toolRead) {
    const found = Object.values(seed.tools)
      .flat()
      .find((tool) => (tool as { slug?: string }).slug === toolRead[1]);
    return found ? json(found) : notFound("Tool");
  }

  if (method === "GET" && api === "/auth_configs") {
    const slug = query.get("toolkit_slug");
    const showDisabled = query.get("show_disabled") === "true";
    const rows = authConfigs.filter(
      (config) =>
        (!slug || config.toolkit === slug) &&
        (showDisabled || config.status === "ENABLED"),
    );
    return json(page(rows.map(authConfigRow)));
  }
  if (method === "POST" && api === "/auth_configs") {
    const input = await body(request);
    const slug = (input.toolkit as { slug?: string } | undefined)?.slug ?? "";
    const app = toolkit(slug);
    if (!app) return notFound("Toolkit");
    const requested = input.auth_config as
      | { name?: string; authScheme?: string }
      | undefined;
    const config: AuthConfig = {
      id: id("ac"),
      uuid: crypto.randomUUID(),
      name: requested?.name ?? `${slug}-e2e`,
      toolkit: slug,
      auth_scheme:
        requested?.authScheme ??
        app.composio_managed_auth_schemes[0] ??
        app.auth_schemes[0] ??
        "OAUTH2",
      status: "ENABLED",
      created_at: now(),
    };
    authConfigs.push(config);
    return json(
      {
        auth_config: {
          id: config.id,
          auth_scheme: config.auth_scheme,
          is_composio_managed: true,
          restrict_to_following_tools: [],
        },
        toolkit: { slug },
      },
      201,
    );
  }
  const configRead = /^\/auth_configs\/([^/]+)$/.exec(api);
  if (configRead) {
    const index = authConfigs.findIndex((row) => row.id === configRead[1]);
    if (index < 0) return notFound("Auth config");
    if (method === "GET") return json(authConfigRow(authConfigs[index]));
    if (method === "DELETE") {
      authConfigs.splice(index, 1);
      return json({});
    }
  }

  if (method === "GET" && api === "/connected_accounts") {
    const configs = many(query, "auth_config_ids");
    const statuses = many(query, "statuses");
    const toolkits = many(query, "toolkit_slugs");
    const users = many(query, "user_ids");
    const rows = accounts.filter(
      (account) =>
        (configs.length === 0 || configs.includes(account.auth_config_id)) &&
        (statuses.length === 0 || statuses.includes(account.status)) &&
        (toolkits.length === 0 || toolkits.includes(account.toolkit)) &&
        (users.length === 0 || users.includes(account.user_id)),
    );
    return json(page(rows.map(accountRow)));
  }
  if (method === "POST" && api === "/connected_accounts/link") {
    const input = await body(request);
    const config = authConfigs.find((row) => row.id === input.auth_config_id);
    if (!config) return notFound("Auth config");
    const account: Account = {
      id: id("ca"),
      auth_config_id: config.id,
      user_id: String(input.user_id ?? ""),
      toolkit: config.toolkit,
      status: "INITIATED",
      callback_url: String(input.callback_url ?? ""),
      link_token: id("lk"),
      created_at: now(),
      updated_at: now(),
    };
    accounts.push(account);
    return json(
      {
        link_token: account.link_token,
        redirect_url: `${COMPOSIO_URL}/link/${account.link_token}`,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        connected_account_id: account.id,
        experimental: { account_type: "PRIVATE" },
      },
      201,
    );
  }
  const accountRead = /^\/connected_accounts\/([^/]+)$/.exec(api);
  if (accountRead) {
    const index = accounts.findIndex((row) => row.id === accountRead[1]);
    if (index < 0) return notFound("Connected account");
    if (method === "GET") return json(accountRow(accounts[index]));
    if (method === "DELETE") {
      accounts.splice(index, 1);
      return json({ success: true });
    }
  }
  return null;
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORTS.composio,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stub/journal") return json({ entries: journal });
    const answer = await route(request, url);
    const response =
      answer ??
      json(
        {
          error: {
            message: `The e2e Composio stub has no answer for ${request.method} ${url.pathname}`,
            code: 501,
            status: 501,
          },
        },
        501,
      );
    if (url.pathname !== "/__stub/health") {
      journal.push({
        method: request.method,
        path: url.pathname,
        status: response.status,
        handled: answer !== null,
      });
      // One line per request, never a header: OpenBot's key for this stub is a dummy anyway.
      console.log(
        `[composio-stub] ${answer ? "answered" : "NO ANSWER"} ${response.status} ${request.method} ${url.pathname}${url.search}`,
      );
    }
    return response;
  },
});
console.log(`[composio-stub] listening on ${COMPOSIO_URL}`);
