export type OriginCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** https:// any host; http:// only for a loopback address with a port, 127.0.0.1 or [::1] (OpenBot Desktop's local stack,
 * Decision 21; never a name such as localhost); no userinfo, path other than "/", query or fragment. */
export function normaliseOpenBotOrigin(raw: string): OriginCheck {
  const url = parse(raw);
  if (!url) return { ok: false, reason: "That is not a web address." };
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "OpenBot's address must start with https://." };
  }
  if (url.username || url.password)
    return {
      ok: false,
      reason: "The address must not contain a user name or password.",
    };
  if (url.pathname !== "/" || url.search || url.hash) {
    return {
      ok: false,
      reason: "Use only the address, such as https://openbot.example.com.",
    };
  }
  if (
    url.protocol === "http:" &&
    !(LOOPBACK_HOSTS.has(url.hostname) && url.port)
  ) {
    return { ok: false, reason: "OpenBot's address must use HTTPS." };
  }
  return { ok: true, origin: url.origin };
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

export function hostPermissionPattern(origin: string): string {
  return `${origin}/*`;
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
