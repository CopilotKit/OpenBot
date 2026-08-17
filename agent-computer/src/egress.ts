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

  // Credentials commonly arrive inside the URL, which is how proxies are handed out. They are split
  // out so that the server string this returns can be shown to a person without leaking a password.
  try {
    const url = new URL(raw.trim());
    const username = url.username
      ? decodeURIComponent(url.username)
      : undefined;
    const password = url.password
      ? decodeURIComponent(url.password)
      : undefined;
    url.username = "";
    url.password = "";
    return {
      server: url.toString().replace(/\/$/, ""),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    // Not a URL. Passed through as a bare `host:port`, which Playwright also accepts, so an operator
    // who writes the obvious thing is not told they are wrong.
    return { server: raw.trim() };
  }
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
