/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at
 * module scope, so importing it to reach one pure function binds a port.
 */
export function streamPathBotId(pathname: string): string | null {
  const named = computerSocketPath(pathname);
  return named?.socket === "stream" ? named.botId : null;
}

/**
 * Which Bot's computer socket a path names, and which socket: its live screen, or its terminal (the
 * Bot's live shell). Both are proxied the same way, behind the same checks.
 */
export function computerSocketPath(
  pathname: string,
): { botId: string; socket: "stream" | "terminal" } | null {
  const match = pathname.match(
    /^\/api\/computers\/([^/]+)\/(stream|terminal)$/,
  );
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      botId: decodeURIComponent(match[1]),
      socket: match[2] === "terminal" ? "terminal" : "stream",
    };
  } catch {
    // A malformed escape is not a Bot id. Decoding it used to throw URIError out of the fetch
    // handler, turning one bad URL into a 500; let normal routing answer it instead.
    return null;
  }
}
