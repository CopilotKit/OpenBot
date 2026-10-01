/**
 * Where a Bot's traffic leaves from.
 *
 * Per-Bot egress identity makes traffic attributable to the Bot that caused it. With a distinct
 * upstream proxy per Bot, the far side sees a different address for each Bot and can enforce network
 * rules alongside application policy.
 *
 * This does not anonymise anything and it is not a security boundary by itself. It
 * gives the far side a stable, per-Bot address to allow-list or attribute, which is what a security
 * team actually asks for. A Bot with no proxy configured goes out directly, which is the right default
 * for a laptop and the wrong one for a deployment that cares.
 *
 * This module has no Playwright import, so proxy parsing tests can run outside the browser image.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";

/** A proxy as Playwright wants it: credentials separated from the URL. */
export type Egress = {
  server: string;
  username?: string;
  password?: string;
};

/**
 * The environment variable naming a Bot's proxy.
 *
 * Upper-cased with anything unusual replaced, because a bot id is a free-form string and an
 * environment variable name is not. `sales-bot` reads `EGRESS_PROXY_SALES_BOT`.
 */
export function egressVariableFor(botId: string): string {
  return `EGRESS_PROXY_${botId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

/**
 * Resolve a Bot's proxy from the environment, or null for direct.
 *
 * `EGRESS_PROXY_<BOT>` names one Bot's proxy; `EGRESS_PROXY_DEFAULT` covers the rest.
 */
export function egressFor(
  botId: string,
  env: Record<string, string | undefined>,
): Egress | null {
  /*
   * While the network-policy filter runs, every Bot's browser goes through it, and it carries the
   * Bot in the proxy credentials so one filter can hold a policy per Bot. The filter chains to the
   * configured upstream itself, so the per-Bot address the far side sees is unchanged.
   */
  if (filter) {
    return {
      server: `http://127.0.0.1:${filter.port}`,
      username: botId,
      password: filter.secret,
    };
  }
  return upstreamFor(botId, env);
}

/** The configured upstream proxy for a Bot, ignoring the filter. */
export function upstreamFor(
  botId: string,
  env: Record<string, string | undefined>,
): Egress | null {
  const raw = env[egressVariableFor(botId)] ?? env.EGRESS_PROXY_DEFAULT;
  if (!raw?.trim()) return null;
  return splitProxyCredentials(raw);
}

/**
 * Split a proxy string into a server and its credentials.
 *
 * Credentials commonly arrive inside the URL, which is how proxies are handed out. They are split out
 * so that the server string can be shown to a person without leaking a password.
 *
 * Two shapes reach here, and only one of them is a URL as far as the parser is concerned. A bare
 * `host:port` is what an operator writes when they are not thinking about URLs, and Playwright and
 * curl both take it; `new URL` reads `proxy.internal:8080` as the scheme `proxy.internal:` and the
 * path `8080` with an empty host, rather than throwing. `username` and `password` come back empty for
 * that shape, so a proxy written `bot:s3cret@proxy.internal:8080` would keep its password in the
 * string it hands back. Re-parsing behind a synthetic scheme makes the split happen for both shapes;
 * the synthetic scheme is then removed so the server reads the way it was written.
 */
export function splitProxyCredentials(raw: string): Egress {
  const trimmed = raw.trim();

  let url: URL | null = null;
  let synthetic = "";
  try {
    const asWritten = new URL(trimmed);
    if (asWritten.host !== "") url = asWritten;
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
  if (!url) {
    synthetic = "http://";
    try {
      url = new URL(`${synthetic}${trimmed}`);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      // Not addressable either way. Passed through, so an operator who writes the obvious thing is
      // not told they are wrong.
      return { server: trimmed };
    }
  }

  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  url.username = "";
  url.password = "";

  return {
    server: url.toString().replace(/\/$/, "").slice(synthetic.length),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * The label for a Bot's egress, for people and for the admin list.
 *
 * Host only. A proxy URL routinely carries a password, and this string is rendered in a browser and
 * returned by an API.
 */
export function egressLabel(
  botId: string,
  env: Record<string, string | undefined>,
): string | null {
  const proxy = upstreamFor(botId, env);
  if (!proxy) return filter ? "network policy filter" : null;
  try {
    // `||` handles bare `proxy.internal:8080`, which URL parses as a scheme plus path and an empty
    // host rather than throwing.
    return new URL(proxy.server).host || proxy.server;
  } catch {
    return proxy.server;
  }
}

/*
 * ---------------------------------------------------------------------------------------------------
 * Network policy: where a Bot's computer may connect.
 *
 * The same four modes Grok Bot's Network Controls offer (no policy, allow all, defaults plus team
 * allowlist, team allowlist only), plus `deny_all`, which is what a Bot gets when its owner's "Cloud
 * network access" capability is off. The rule engine below is pure and is also what the API server
 * imports to refuse a navigation before it reaches the computer, so the two ends cannot disagree.
 *
 * The filter proxy is what enforces it on the computer itself: the browser is pointed at it through
 * `egressFor`, and shell commands through HTTP(S)_PROXY. A policy pushed to a running computer is
 * consulted on the next connection, so it applies without restarting anything.
 *
 * WHAT THIS CANNOT STOP: a process that ignores proxy variables and opens a raw socket. That is the
 * Kubernetes NetworkPolicy's job, which this narrows rather than replaces.
 * ---------------------------------------------------------------------------------------------------
 */

export type EgressRule =
  | { type: "domain"; value: string }
  | { type: "cidr"; value: string; ports?: string };

export type EgressMode =
  | "allow_all"
  | "defaults_plus_allowlist"
  | "allowlist_only"
  | "deny_all";

export type EgressPolicy = { mode: EgressMode; rules: EgressRule[] };

export const EGRESS_MODES: readonly EgressMode[] = [
  "allow_all",
  "defaults_plus_allowlist",
  "allowlist_only",
  "deny_all",
];

/**
 * What "defaults" means in `defaults_plus_allowlist`: the package registries and source hosts a
 * development computer needs to install anything at all.
 */
export const DEFAULT_EGRESS_DESTINATIONS: readonly string[] = [
  "github.com",
  "githubusercontent.com",
  "ghcr.io",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
];

const DOMAIN =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
}

function parseCidr(
  value: string,
): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [address = "", prefixText] = value.trim().split("/");
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

function portsMatch(spec: string | undefined, port: number): boolean {
  if (!spec?.trim()) return true;
  return spec.split(",").some((part) => {
    const [low, high] = part.split("-").map(Number);
    if (low === undefined) return false;
    return high === undefined ? port === low : port >= low && port <= high;
  });
}

/** Read a rule list from JSON, refusing anything that is not exactly a rule. */
export function parseEgressRules(
  input: unknown,
): { ok: true; rules: EgressRule[] } | { ok: false; error: string } {
  if (!Array.isArray(input))
    return { ok: false, error: "rules must be a list." };
  const rules: EgressRule[] = [];
  for (const [index, raw] of input.entries()) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `Rule ${index + 1} is not an object.` };
    }
    if (entry.type === "domain" && typeof entry.value === "string") {
      const value = normalizeHost(entry.value);
      if (!DOMAIN.test(value)) {
        return { ok: false, error: `"${entry.value}" is not a domain.` };
      }
      rules.push({ type: "domain", value });
      continue;
    }
    if (entry.type === "cidr" && typeof entry.value === "string") {
      if (!parseCidr(entry.value)) {
        return {
          ok: false,
          error: `"${entry.value}" is not an IP address or range such as 10.0.0.0/8.`,
        };
      }
      const ports =
        typeof entry.ports === "string" && entry.ports.trim()
          ? entry.ports.replaceAll(" ", "")
          : undefined;
      if (ports !== undefined && !PORTS.test(ports)) {
        return {
          ok: false,
          error: `"${entry.ports}" is not a port list such as 443 or 5432,8000-8100.`,
        };
      }
      rules.push({
        type: "cidr",
        value: entry.value.trim(),
        ...(ports ? { ports } : {}),
      });
      continue;
    }
    return {
      ok: false,
      error: `Rule ${index + 1} must be { type: "domain", value } or { type: "cidr", value, ports? }.`,
    };
  }
  return { ok: true, rules };
}

export function parseEgressPolicy(
  input: unknown,
): { ok: true; policy: EgressPolicy } | { ok: false; error: string } {
  const candidate = input as { mode?: unknown; rules?: unknown } | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !EGRESS_MODES.includes(candidate.mode as EgressMode)
  ) {
    return {
      ok: false,
      error: `mode must be one of ${EGRESS_MODES.join(", ")}.`,
    };
  }
  const rules = parseEgressRules(candidate.rules ?? []);
  if (!rules.ok) return rules;
  return {
    ok: true,
    policy: { mode: candidate.mode as EgressMode, rules: rules.rules },
  };
}

function domainMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern || host.endsWith(`.${pattern}`);
}

function addressMatches(rule: EgressRule, address: string, port: number) {
  if (rule.type !== "cidr" || !portsMatch(rule.ports, port)) return false;
  const cidr = parseCidr(rule.value);
  const version = isIP(address);
  if (!cidr || version === 0) return false;
  const list = new BlockList();
  list.addSubnet(cidr.address, cidr.prefix, cidr.family);
  return list.check(address, version === 4 ? "ipv4" : "ipv6");
}

export type EgressDecision = { allowed: boolean; reason: string };

/**
 * May this connection go out?
 *
 * `resolved` is what the host name resolved to, when the caller resolved it. A domain rule matches a
 * name; an IP-range rule matches an address, whether the Bot dialled the address directly or a name
 * that resolved inside the range. Every resolved address must be inside an allowed range, so a name
 * that resolves partly outside is refused rather than connected to whichever address came first.
 */
export function egressDecision(
  policy: EgressPolicy,
  hostInput: string,
  port: number,
  resolved: readonly string[] = [],
): EgressDecision {
  const host = normalizeHost(hostInput);
  if (policy.mode === "allow_all") {
    return {
      allowed: true,
      reason: "The network policy allows all destinations.",
    };
  }
  if (policy.mode === "deny_all") {
    return {
      allowed: false,
      reason: "Network access is turned off for this Bot's computer.",
    };
  }
  const domains = [
    ...(policy.mode === "defaults_plus_allowlist"
      ? DEFAULT_EGRESS_DESTINATIONS
      : []),
    ...policy.rules.flatMap((rule) =>
      rule.type === "domain" ? [rule.value] : [],
    ),
  ];
  if (
    isIP(host) === 0 &&
    domains.some((pattern) => domainMatches(pattern, host))
  ) {
    return { allowed: true, reason: `${host} is on the allowlist.` };
  }
  const addresses = isIP(host) !== 0 ? [host] : [...resolved];
  if (
    addresses.length > 0 &&
    addresses.every((address) =>
      policy.rules.some((rule) => addressMatches(rule, address, port)),
    )
  ) {
    return {
      allowed: true,
      reason: `${host}:${port} is inside an allowed range.`,
    };
  }
  return {
    allowed: false,
    reason: `${host}:${port} is not on this deployment's network allowlist.`,
  };
}

/** True when deciding needs the host's addresses: a name, and at least one IP-range rule. */
export function needsResolution(policy: EgressPolicy, host: string): boolean {
  return (
    isIP(normalizeHost(host)) === 0 &&
    policy.mode !== "allow_all" &&
    policy.mode !== "deny_all" &&
    policy.rules.some((rule) => rule.type === "cidr")
  );
}

/* --------------------------------- the filter on the computer --------------------------------- */

type RunningFilter = { port: number; secret: string; server: Server };
let filter: RunningFilter | null = null;
const policies = new Map<string, EgressPolicy>();
let policyRequired = false;

/** Install (or with null, remove) the policy one Bot's connections are judged by. */
export function setEgressPolicy(botId: string, policy: EgressPolicy | null) {
  if (policy) policies.set(botId, policy);
  else policies.delete(botId);
}

export function egressPolicyFor(botId: string): EgressPolicy | undefined {
  return policies.get(botId);
}

/**
 * Which policies judge a connection.
 *
 * A connection carrying a Bot in its proxy credentials is judged by that Bot's policy. One without
 * (a shell command, whose proxy variable has no credentials in it) is judged by the only policy on
 * this computer when there is one, and otherwise by every policy at once, so the most restrictive
 * wins. Nothing pushed yet allows, unless EGRESS_POLICY_REQUIRED says to refuse until a policy
 * arrives.
 */
function policiesFor(botId: string | undefined): EgressPolicy[] | "refuse" {
  if (botId) {
    const own = policies.get(botId);
    if (own) return [own];
    return policyRequired ? "refuse" : [];
  }
  if (policies.size === 0) return policyRequired ? "refuse" : [];
  return [...policies.values()];
}

async function decide(
  botId: string | undefined,
  host: string,
  port: number,
): Promise<EgressDecision & { address?: string }> {
  const judging = policiesFor(botId);
  if (judging === "refuse") {
    return {
      allowed: false,
      reason:
        "No network policy has reached this computer yet, so nothing may leave it.",
    };
  }
  let resolved: string[] = [];
  if (judging.some((policy) => needsResolution(policy, host))) {
    try {
      resolved = (await lookup(normalizeHost(host), { all: true })).map(
        (entry) => entry.address,
      );
    } catch {
      return { allowed: false, reason: `${host} could not be resolved.` };
    }
  }
  for (const policy of judging) {
    const decision = egressDecision(policy, host, port, resolved);
    if (!decision.allowed) return decision;
  }
  // Connect to the address that was checked, so a second lookup cannot answer differently.
  return {
    allowed: true,
    reason: "Allowed.",
    ...(resolved[0] ? { address: resolved[0] } : {}),
  };
}

function botFromProxyAuthorization(
  header: string | undefined,
  secret: string,
): string | undefined {
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return undefined;
  const offered = Buffer.from(decoded.slice(colon + 1));
  const expected = Buffer.from(secret);
  if (
    offered.length !== expected.length ||
    !timingSafeEqual(offered, expected)
  ) {
    return undefined;
  }
  return decoded.slice(0, colon);
}

function basic(username?: string, password?: string): string | undefined {
  if (username === undefined) return undefined;
  return `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`;
}

function upstreamAddress(upstream: Egress): { host: string; port: number } {
  const url = new URL(
    /^[a-z]+:\/\//i.test(upstream.server)
      ? upstream.server
      : `http://${upstream.server}`,
  );
  return { host: url.hostname, port: Number(url.port || 80) };
}

function refuse(socket: Socket, reason: string) {
  socket.end(
    `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nx-openbot-egress: refused\r\ncontent-length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  );
}

/** Open a tunnel to host:port, through the upstream proxy when there is one. */
function tunnel(
  target: { host: string; port: number },
  upstream: Egress | null,
  onReady: (socket: Socket) => void,
  onError: (error: Error) => void,
) {
  if (!upstream) {
    const socket = connect(target.port, target.host, () => onReady(socket));
    socket.once("error", onError);
    return;
  }
  const via = upstreamAddress(upstream);
  const socket = connect(via.port, via.host, () => {
    const auth = basic(upstream.username, upstream.password);
    socket.write(
      `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
    );
  });
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    socket.off("data", onData);
    if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString())) {
      socket.destroy();
      onError(new Error("The upstream proxy refused the tunnel."));
      return;
    }
    const rest = head.subarray(end + 4);
    if (rest.length > 0) socket.unshift(rest);
    onReady(socket);
  };
  socket.on("data", onData);
  socket.once("error", onError);
}

export type EgressFilterOptions = {
  env?: Record<string, string | undefined>;
  /** 0 picks a free port. */
  port?: number;
  /** Also point this process's HTTP(S)_PROXY at the filter, so shell commands go through it. */
  exportToProcessEnv?: boolean;
};

/**
 * Start the filter on 127.0.0.1.
 *
 * Idempotent: a second call answers the running filter. Chains to the Bot's configured upstream
 * (`EGRESS_PROXY_<BOT>` / `EGRESS_PROXY_DEFAULT`), so the per-Bot egress identity is kept.
 */
export async function startEgressFilter(
  options: EgressFilterOptions = {},
): Promise<{ port: number; url: string; stop: () => Promise<void> }> {
  const env = options.env ?? process.env;
  policyRequired =
    env.EGRESS_POLICY_REQUIRED === "1" || env.EGRESS_POLICY_REQUIRED === "true";
  if (filter) {
    return {
      port: filter.port,
      url: `http://127.0.0.1:${filter.port}`,
      stop: stopEgressFilter,
    };
  }
  const secret = randomBytes(24).toString("base64url");

  const server = createServer(async (request, response) => {
    // A plain-HTTP request through a proxy names the absolute URL.
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end("A proxy request names an absolute URL.");
      return;
    }
    const botId = botFromProxyAuthorization(
      request.headers["proxy-authorization"] as string | undefined,
      secret,
    );
    const port = Number(
      target.port || (target.protocol === "https:" ? 443 : 80),
    );
    const decision = await decide(botId, target.hostname, port);
    if (!decision.allowed) {
      response
        .writeHead(403, {
          "content-type": "text/plain",
          "x-openbot-egress": "refused",
        })
        .end(decision.reason);
      return;
    }
    forwardPlain(
      request,
      response,
      target,
      botId ? upstreamFor(botId, env) : upstreamFor("", env),
    );
  });

  server.on(
    "connect",
    async (request: IncomingMessage, client: Socket, head: Buffer) => {
      const [host = "", portText = "443"] = splitHostPort(request.url ?? "");
      const port = Number(portText);
      const botId = botFromProxyAuthorization(
        request.headers["proxy-authorization"] as string | undefined,
        secret,
      );
      client.on("error", () => undefined);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        refuse(client, "A CONNECT names host:port.");
        return;
      }
      const decision = await decide(botId, host, port);
      if (!decision.allowed) {
        refuse(client, decision.reason);
        return;
      }
      const upstream = upstreamFor(botId ?? "", env);
      tunnel(
        { host: upstream ? host : (decision.address ?? host), port },
        upstream,
        (remote) => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) remote.write(head);
          remote.pipe(client);
          client.pipe(remote);
          remote.on("error", () => client.destroy());
        },
        () => {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        },
      );
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  filter = { port, secret, server };

  const url = `http://127.0.0.1:${port}`;
  if (options.exportToProcessEnv) {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ]) {
      process.env[name] = url;
    }
    // The computer's own loopback services are not the network.
    process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost,::1";
  }
  return { port, url, stop: stopEgressFilter };
}

export async function stopEgressFilter(): Promise<void> {
  const running = filter;
  filter = null;
  policies.clear();
  if (running) {
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
  }
}

function splitHostPort(value: string): [string, string] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return [value.slice(1, end), value.slice(end + 2) || "443"];
  }
  const colon = value.lastIndexOf(":");
  return colon === -1
    ? [value, "443"]
    : [value.slice(0, colon), value.slice(colon + 1)];
}

function forwardPlain(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  target: URL,
  upstream: Egress | null,
) {
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const via = upstream ? upstreamAddress(upstream) : null;
  const auth = upstream
    ? basic(upstream.username, upstream.password)
    : undefined;
  const outbound = httpRequest(
    {
      host: via ? via.host : target.hostname,
      port: via ? via.port : Number(target.port || 80),
      method: request.method,
      path: via ? target.toString() : `${target.pathname}${target.search}`,
      headers: { ...headers, ...(auth ? { "proxy-authorization": auth } : {}) },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  outbound.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(outbound);
}

/**
 * `PUT /egress-policy` on the computer: the API server pushing a Bot's policy.
 *
 * Mounted by index.ts after its token check. The body is `{ policy: EgressPolicy | null }`; null
 * removes the Bot's policy, which returns it to "nothing pushed".
 */
export async function handleEgressPolicyRequest(
  botId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    policy?: unknown;
  } | null;
  if (!body || !("policy" in body)) {
    return Response.json({ error: "Expected { policy }." }, { status: 400 });
  }
  if (body.policy === null) {
    setEgressPolicy(botId, null);
    return Response.json({ botId, policy: null, filtering: filter !== null });
  }
  const parsed = parseEgressPolicy(body.policy);
  if (!parsed.ok)
    return Response.json({ error: parsed.error }, { status: 400 });
  setEgressPolicy(botId, parsed.policy);
  return Response.json({
    botId,
    policy: parsed.policy,
    filtering: filter !== null,
  });
}
