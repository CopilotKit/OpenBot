/**
 * Who may speak to a computer at all.
 *
 * This check is the boundary in front of the browser process. Policy, audit and sign-in live in the
 * API server and are not on the direct computer port.
 *
 * It lives here rather than in `index.ts` because that file imports Playwright at module scope, so
 * anything in it needs Chrome merely to be imported by a test. The same reasoning moved the control
 * state machine out: if a decision matters, it does not belong next to `chromium.launch()`.
 */

/**
 * Does this secret match?
 *
 * Constant-time comparison prevents prefix timing leaks. Length still leaks, but not token content.
 */
export function matchesToken(expected: string, offered: string): boolean {
  if (expected.length === 0) return false;
  if (offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The secret a caller offered, however it could carry it.
 *
 * WebSocket clients cannot set upgrade headers, so the page stream and full desktop also accept the
 * token as a query parameter.
 */
export function offeredToken(headers: Headers, url: URL): string {
  if (url.pathname === "/stream" || url.pathname === "/desktop") {
    return url.searchParams.get("token") ?? "";
  }
  const header = headers.get("x-openbot-computer-token")?.trim();
  if (header) return header;
  const authorization = headers.get("authorization")?.trim() ?? "";
  return authorization.replace(/^Bearer /i, "");
}

/**
 * Health is the one thing an unauthenticated caller may ask.
 *
 * An orchestrator has to be able to check whether this process is up without holding a secret, and
 * the answer names no Bot, touches no browser and reveals nothing about what is running.
 */
export function isOpenPath(pathname: string): boolean {
  return pathname === "/health";
}

/**
 * Which paths act on the computer, and so are refused while a person holds the wheel.
 *
 * One list, asked once per request, rather than a check inside each handler. The shell is the reason:
 * `/exec` arrived after the wheel existed and was never given the guard the page paths had, so a Bot
 * could keep running commands and writing files underneath somebody who had taken the browser at a
 * login wall. A per-handler check is exactly the thing the next endpoint forgets, which is how that
 * happened; a list the dispatcher consults is one an endpoint has to be added to.
 *
 * Reading is not acting. `/files/read` and `/files/list` stay open so a Bot that has been stopped can
 * still read its own notes and explain what it was doing, which is the answer the person handing the
 * wheel back usually wants.
 */
const ACTING_PATHS = new Set([
  "/navigate",
  "/click",
  "/type",
  "/key",
  "/scroll",
  "/exec",
  "/files/write",
]);

export function actsOnTheComputer(pathname: string): boolean {
  return ACTING_PATHS.has(pathname);
}
