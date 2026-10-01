/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at
 * module scope, so importing it to reach one pure function binds a port.
 */
export function streamPathBotId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape is not a Bot id. Decoding it used to throw URIError out of the fetch
    // handler, turning one bad URL into a 500; let normal routing answer it instead.
    return null;
  }
}
