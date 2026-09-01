export type ComputerSocketKind = "stream" | "desktop";

export type ComputerSocketPath = {
  botId: string;
  kind: ComputerSocketKind;
};

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
}): string {
  const mode = input.mode === "control" ? "control" : "view";
  const query = new URLSearchParams({
    bot: input.botId,
    token: input.token,
    ...(input.kind === "desktop" ? { mode } : {}),
  });
  return `${input.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/${input.kind}?${query}`;
}
