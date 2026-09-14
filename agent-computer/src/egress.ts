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
  const proxy = egressFor(botId, env);
  if (!proxy) return null;
  try {
    // `||` handles bare `proxy.internal:8080`, which URL parses as a scheme plus path and an empty
    // host rather than throwing.
    return new URL(proxy.server).host || proxy.server;
  } catch {
    return proxy.server;
  }
}
