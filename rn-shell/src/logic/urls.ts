/**
 * The addresses of the sign-in hand-off and its renewal, built to the letter of the server's contract
 * (openbot-backend docs/shell-sign-in.md, "The enter contract" and "Renewing the hosted sign-in"),
 * plus the origin checks every other part of the app leans on. Pure: unit-tested in
 * __tests__/urls.test.ts against the doc's worked example.
 */

export type Platform = "ios" | "android";

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;
const HEX = "0123456789ABCDEF";

/** Percent-encodes every character outside `A-Z a-z 0-9 - _ . ~` (UTF-8, capital hex): one query value. */
export function encodeValue(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && UNRESERVED.test(char)) out += char;
    else out += `%${HEX[byte >> 4]}${HEX[byte & 0xf]}`;
  }
  return out;
}

/** `scheme://host[:port]` of an absolute http(s) URL, lowercased, or null. No `URL` needed (Hermes has one, but tests and old engines agree on this). */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^(https?):\/\/([^/?#@]*@)?([^/?#:]+|\[[^\]]+\])(:\d+)?(?:[/?#]|$)/i.exec(url);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const host = match[3].toLowerCase();
  let port = match[4] ?? "";
  if ((scheme === "https" && port === ":443") || (scheme === "http" && port === ":80")) port = "";
  return `${scheme}://${host}${port}`;
}

/** The lowercased scheme of any URL (`mailto`, `https`, `openbotshell`), or "". */
export function schemeOf(url: string | null | undefined): string {
  const match = /^([A-Za-z][A-Za-z0-9+\-.]*):/.exec(url ?? "");
  return match ? match[1].toLowerCase() : "";
}

/** The path of an absolute http(s) URL ("/" when empty), without query or fragment. */
export function pathOf(url: string | null | undefined): string {
  const match = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(url ?? "");
  if (!match) return "";
  return match[1] === "" ? "/" : match[1];
}

/** Path, query and fragment of an absolute http(s) URL. */
export function pathQueryFragmentOf(url: string): string {
  const match = /^https?:\/\/[^/?#]*(.*)$/i.exec(url);
  if (!match) return "/";
  const rest = match[1];
  return rest === "" || rest.startsWith("?") || rest.startsWith("#") ? `/${rest}` : rest;
}

export function isOwnOrigin(url: string | null | undefined, origin: string): boolean {
  const found = originOf(url);
  return found !== null && found === originOf(origin);
}

export function isSignPath(path: string): boolean {
  return path === "/sign" || path.startsWith("/sign/");
}

/** Under `/api/auth/shell/`: the hand-off's addresses, which carry the ticket and the verifier. */
export function isShellAuthUrl(url: string | null | undefined, origin: string): boolean {
  return isOwnOrigin(url, origin) && pathOf(url).startsWith("/api/auth/shell/");
}

/** A page of the app a retry or a restart may load again: own origin, not /sign, not under /api/. */
export function isReloadableOwnUrl(url: string | null | undefined, origin: string): boolean {
  if (!isOwnOrigin(url, origin)) return false;
  const path = pathOf(url);
  return !path.startsWith("/api/") && !isSignPath(path);
}

/** `/api/auth/shell/handoff?challenge=<C>&platform=<P>&callback=<https|scheme>`, in that order. */
export function handoffPath(challenge: string, platform: Platform, callback: "https" | "scheme" | null): string {
  let path = `/api/auth/shell/handoff?challenge=${encodeValue(challenge)}&platform=${encodeValue(platform)}`;
  if (callback) path += `&callback=${encodeValue(callback)}`;
  return path;
}

/** The sheet's address for a renewal: the hosted sign-in, returning to the hand-off. */
export function renewalUrl(origin: string, handoff: string): string {
  return `${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue(handoff)}`;
}

/** `GET <origin>/api/auth/shell/enter?ticket=<T>&verifier=<V>&to=<to>`, each one encoded value. */
export function enterUrl(origin: string, ticket: string, verifier: string, to: string): string {
  return `${origin}/api/auth/shell/enter?ticket=${encodeValue(ticket)}&verifier=${encodeValue(verifier)}&to=${encodeValue(to)}`;
}

/** The raw (still encoded) value of query parameter `name`, or null. */
export function rawQueryValue(url: string, name: string): string | null {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return null;
  const hash = url.indexOf("#", queryStart);
  const query = url.slice(queryStart + 1, hash < 0 ? undefined : hash);
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    const key = equals < 0 ? pair : pair.slice(0, equals);
    if (key === name) return equals < 0 ? "" : pair.slice(equals + 1);
  }
  return null;
}

function decodeOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, "%2B"));
  } catch {
    return null;
  }
}

/**
 * Where a renewal comes back to: the intercepted hosted sign-in's `returnTo`, decoded once, when it
 * is on the OpenBot host (its path, query and fragment); "/" otherwise.
 */
export function renewalTo(intercepted: string, origin: string): string {
  const raw = rawQueryValue(intercepted, "returnTo");
  if (raw === null) return "/";
  const returnTo = decodeOnce(raw);
  if (returnTo === null) return "/";
  if (returnTo.startsWith("/")) return returnTo.startsWith("//") || returnTo.includes("\\") ? "/" : returnTo;
  if (!isOwnOrigin(returnTo, origin)) return "/";
  const to = pathQueryFragmentOf(returnTo);
  return to.startsWith("/") && !to.startsWith("//") ? to : "/";
}

/** True for the hosted sign-in the web app navigates to when its proof runs out. */
export function isHostedSignIn(url: string, origin: string): boolean {
  return isOwnOrigin(url, origin) && pathOf(url) === "/api/auth/hosted/sign-in";
}

/**
 * A URL for a log line: origin and path, and the names of the query parameters but never their
 * values. Anything under /api/auth/shell/ keeps its path only.
 */
export function redact(url: string | null | undefined): string {
  if (!url) return "";
  const scheme = schemeOf(url);
  if (scheme !== "http" && scheme !== "https") return scheme ? `${scheme}:` : "";
  const origin = originOf(url) ?? "";
  const path = pathOf(url);
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return origin + path;
  const hash = url.indexOf("#", queryStart);
  const names = url
    .slice(queryStart + 1, hash < 0 ? undefined : hash)
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair) => pair.split("=")[0]);
  return `${origin}${path}?${names.map((name) => `${name}=…`).join("&")}`;
}
