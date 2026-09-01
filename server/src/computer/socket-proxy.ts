export type ComputerSocketKind = "stream" | "desktop";

export type ComputerSocketPath = {
  botId: string;
  kind: ComputerSocketKind;
};

const CONTROL_LEASE_PROTOCOL = "openbot-lease.";
const CONTROL_LEASE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * Read the browser's private control capability without putting it in a public URL.
 *
 * WebSocket subprotocols cross the authenticated upgrade but do not appear in the address bar,
 * browser history, reverse-proxy query logs, or screenshot tooling. The upstream URL is internal.
 */
export function parseComputerSocketLease(
  requestedProtocols: string | null,
): string | undefined {
  for (const protocol of (requestedProtocols ?? "").split(",")) {
    const candidate = protocol.trim();
    if (!candidate.startsWith(CONTROL_LEASE_PROTOCOL)) continue;
    const lease = candidate.slice(CONTROL_LEASE_PROTOCOL.length);
    if (CONTROL_LEASE_TOKEN.test(lease)) return lease;
  }
  return undefined;
}

/**
 * A framebuffer contains every window on its X display, not just the browser profile named in the
 * URL. It is therefore safe to proxy only when the provider gives that Bot the whole computer.
 * Page streaming remains available on shared providers because CDP keeps those sessions separate.
 */
export function computerSocketIsolationRefusal(
  kind: ComputerSocketKind,
  isolation: "per-bot" | "shared" | undefined,
): string | undefined {
  if (kind === "desktop" && isolation !== "per-bot") {
    return "A full desktop requires one isolated computer per Bot.";
  }
  return undefined;
}

/** The only two computer WebSockets the public server will proxy. */
export function parseComputerSocketPath(
  pathname: string,
): ComputerSocketPath | null {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/(stream|desktop)$/);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      botId: decodeURIComponent(match[1]),
      kind: match[2] as ComputerSocketKind,
    };
  } catch {
    return null;
  }
}

/**
 * Build the internal socket without ever exposing the computer token to the browser.
 *
 * Unknown desktop modes fail closed to the read-only connection. The computer repeats the control
 * check at upgrade and for every control message, so this URL is routing rather than authority.
 */
export function computerSocketUrl(input: {
  baseUrl: string;
  botId: string;
  kind: ComputerSocketKind;
  token: string;
  mode?: string | null;
  lease?: string;
}): string {
  const mode = input.mode === "control" ? "control" : "view";
  const query = new URLSearchParams({
    bot: input.botId,
    token: input.token,
    ...(input.kind === "desktop" ? { mode } : {}),
    ...(input.lease ? { lease: input.lease } : {}),
  });
  return `${input.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/${input.kind}?${query}`;
}
