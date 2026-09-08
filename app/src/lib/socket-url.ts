/**
 * A WebSocket's address, same-origin unless a Vite runtime says otherwise.
 *
 * In production the server serves the app and answers the `/api` WebSocket upgrade on the same
 * origin, so the browser's own host is the target — including behind an ingress that terminates TLS
 * on 443 and never exposes the container's port. Deriving the socket from `window.location` is the
 * standard shape for a reverse-proxied deployment, and it is the default here because it is the case
 * that must not break.
 *
 * Development and the desktop's `vite preview` are the exception. There Vite serves the app on
 * APP_PORT and proxies `/api` to the server on SERVER_PORT, a different origin, and under bun that
 * proxy cannot carry a WebSocket at all (oven-sh/bun#24127): the upgrade is answered with a plain
 * HTTP response and the socket never opens. So those two runtimes address the server directly, by
 * the port each announces on `window.__OPENBOT_WS_PORT__`. Nothing announces it in the built bundle
 * the server hands out, so a production page has no port to override with and stays same-origin.
 */
declare global {
  interface Window {
    __OPENBOT_WS_PORT__?: string;
  }
}

function announcedPort(): string {
  return typeof window !== "undefined" &&
    typeof window.__OPENBOT_WS_PORT__ === "string"
    ? window.__OPENBOT_WS_PORT__
    : "";
}

export function socketUrl(
  path: string,
  location: {
    protocol: string;
    hostname: string;
    host: string;
  } = window.location,
  port: string = announcedPort(),
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  // A port only when a Vite runtime named one: the app is not same-origin with the server there.
  // Otherwise the browser's own host, which is the server's own origin in production.
  const authority = port ? `${location.hostname}:${port}` : location.host;
  return `${scheme}//${authority}${path}`;
}
