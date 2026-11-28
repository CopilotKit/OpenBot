/**
 * What the server's `GET /api/auth/shell/config?platform=<ios|android>` answer means for signing in,
 * strictly, as the native shells decide it (ios-shell HandoffConfig.swift, android-shell
 * HandoffConfig.kt). Pure: unit-tested in __tests__/handoffConfig.test.ts.
 */

export type HandoffMode =
  /** No answer at all (network error, timeout): the lock screen. */
  | { kind: "unreachable"; reason: string }
  /** No hand-off here, or an answer this app does not understand: the web app's own sign-in. */
  | { kind: "webSignIn"; reason: string }
  /** The sheet finishes on `openbotshell://signed-in?ticket=`. */
  | { kind: "scheme" }
  /** The sheet finishes on `https://<host><path>?ticket=`, which only this app can claim. */
  | { kind: "https"; host: string; path: string; url: string };

export const SCHEME_CALLBACK = "openbotshell://signed-in";

/** A ticket as the server mints it (32 random bytes, base64url), with room to spare. */
export const TICKET = /^[A-Za-z0-9._~-]{16,512}$/;

/**
 * Decides from the HTTP status (null: no answer) and body text. `handoff` must be a boolean; when
 * true, `callback` must be "scheme" with `callbackUrl` exactly openbotshell://signed-in, or "https"
 * with an https `callbackUrl` on the base host, no port, query or fragment, and a path. Keys beyond
 * these are ignored, so the server can add some.
 */
export function decideHandoff(
  status: number | null,
  body: string | null,
  baseHost: string,
  httpsCallbackSupported: boolean,
): HandoffMode {
  if (status === null) return { kind: "unreachable", reason: "no-answer" };
  if (status !== 200) return { kind: "webSignIn", reason: `status-${status}` };
  let object: unknown;
  try {
    object = JSON.parse(body ?? "");
  } catch {
    return { kind: "webSignIn", reason: "not-json-object" };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object))
    return { kind: "webSignIn", reason: "not-json-object" };
  const record = object as Record<string, unknown>;
  if (typeof record.handoff !== "boolean")
    return { kind: "webSignIn", reason: "handoff-not-boolean" };
  if (!record.handoff) return { kind: "webSignIn", reason: "handoff-off" };
  const callback = record.callback;
  const callbackUrl = record.callbackUrl;
  if (typeof callback !== "string" || typeof callbackUrl !== "string")
    return { kind: "webSignIn", reason: "callback-missing" };
  if (callback === "scheme")
    return callbackUrl === SCHEME_CALLBACK
      ? { kind: "scheme" }
      : { kind: "webSignIn", reason: "scheme-url-unexpected" };
  if (callback === "https") {
    const match = /^https:\/\/([^/?#:@]+)(\/[^?#]*)$/i.exec(callbackUrl);
    if (!match) return { kind: "webSignIn", reason: "https-url-unexpected" };
    const host = match[1].toLowerCase();
    const path = match[2];
    if (host !== baseHost.toLowerCase() || path === "/" || path === "")
      return { kind: "webSignIn", reason: "https-url-unexpected" };
    if (!httpsCallbackSupported)
      return { kind: "webSignIn", reason: "https-callback-unsupported" };
    return { kind: "https", host, path, url: `https://${host}${path}` };
  }
  return { kind: "webSignIn", reason: "callback-unknown" };
}

/** The callback name the hand-off is told, from what the config said. */
export function callbackName(mode: HandoffMode): "https" | "scheme" | null {
  if (mode.kind === "scheme") return "scheme";
  if (mode.kind === "https") return "https";
  return null;
}

/** Where the sheet must finish for this mode (expo-web-browser's redirect URL). */
export function redirectUrlFor(mode: HandoffMode): string | null {
  if (mode.kind === "scheme") return SCHEME_CALLBACK;
  if (mode.kind === "https") return mode.url;
  return null;
}

/**
 * The ticket, when `url` is the callback this mode expects and carries one well-formed ticket;
 * otherwise null (and a pending sign-in stays pending: any app can fire openbotshell://).
 */
export function ticketFrom(
  url: string | null | undefined,
  mode: HandoffMode | null,
): string | null {
  if (!url || !mode) return null;
  if (mode.kind === "scheme") {
    if (!/^openbotshell:\/\/signed-in(?:[/?#]|$)/i.test(url)) return null;
    if (/^openbotshell:\/\/signed-in\/[^?#]/i.test(url)) return null;
  } else if (mode.kind === "https") {
    const match = /^https:\/\/([^/?#:@]+)([^?#]*)/i.exec(url);
    if (
      !match ||
      match[1].toLowerCase() !== mode.host ||
      match[2] !== mode.path
    )
      return null;
  } else {
    return null;
  }
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return null;
  const hash = url.indexOf("#", queryStart);
  const tickets = url
    .slice(queryStart + 1, hash < 0 ? undefined : hash)
    .split("&")
    .filter((pair) => pair.split("=")[0] === "ticket")
    .map((pair) => pair.slice(pair.indexOf("=") + 1));
  if (tickets.length !== 1) return null;
  const ticket = tickets[0];
  return TICKET.test(ticket) ? ticket : null;
}
