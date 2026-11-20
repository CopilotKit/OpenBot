// The OpenBot address rule and the gateway rule live beside the Recorder's API in shared/, so OpenBot itself checks an
// address with the same rule before it hands one to the Recorder (the OpenBot browser's connection, the capture pass's
// gateway).
export {
  isAllowedGatewayUrl,
  normaliseOpenBotOrigin,
} from "@openbot/shared/recorder-api";

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
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
