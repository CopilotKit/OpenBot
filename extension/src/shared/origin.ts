// The OpenBot address rule lives beside the Recorder's API in shared/, so OpenBot itself checks an address with the same
// rule before it hands one to the Recorder (the OpenBot browser's connection).
export { normaliseOpenBotOrigin } from "@openbot/shared/recorder-api";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** wss:// required; ws:// only when the gateway host is 127.0.0.1 or [::1]; when `allowed` is not null the
 * grant's origin must equal one of the allowed URLs' origins. */
export function isAllowedGatewayUrl(
  clientUrl: string,
  allowed: readonly string[] | null,
): boolean {
  const url = parse(clientUrl);
  if (!url) return false;
  const secure = url.protocol === "wss:";
  if (!secure && !(url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname)))
    return false;
  if (allowed === null) return true;
  return allowed.some((entry) => parse(entry)?.origin === url.origin);
}

const NON_RECORDABLE_HOSTS = new Set([
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
]);

/** http: or https: only (chrome://, the Web Store, PDF viewer: false). */
export function isRecordablePage(url: string | undefined): boolean {
  if (typeof url !== "string") return false;
  const parsed = parse(url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
    return false;
  if (NON_RECORDABLE_HOSTS.has(parsed.hostname)) return false;
  return !(
    parsed.hostname === "chrome.google.com" &&
    parsed.pathname.startsWith("/webstore")
  );
}
