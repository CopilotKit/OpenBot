/**
 * A browser's stand-in for a signed-in person, used only when the deployment has no identity
 * provider.
 *
 * The id is minted in localStorage and sent on every request. It is not a credential: anybody who
 * copies it can pretend to be that browser. It exists so two laptops sharing one no-auth
 * deployment do not share one conversation roster.
 */

/** Sent on ordinary HTTP. Browsers cannot set headers on `WebSocket()`, so that path uses the query. */
export const BROWSER_ID_HEADER = "x-openbot-browser-id";

/** Query name for WebSocket upgrades, where custom headers are not available. */
export const BROWSER_ID_QUERY = "browserId";

/**
 * A UUID, any version, with the RFC variant.
 *
 * Reject anything else so a header cannot become a user id. The browser mints version 4; the
 * check is wider so a remembered id from another generator still works.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseBrowserId(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return UUID.test(trimmed) ? trimmed : null;
}

/** The users.id used for a browser, so the row is visibly not a signed-in person. */
export function browserUserId(browserId: string): string {
  return `browser-${browserId}`;
}

export function browserUserEmail(browserId: string): string {
  return `${browserUserId(browserId)}@openbot.local`;
}

/**
 * The browser id this request is speaking as, if it sent one.
 *
 * Header wins: it is how the app identifies itself. The query is only for the socket upgrade.
 */
export function browserIdFromRequest(request: {
  headers: { get(name: string): string | null };
  url: string;
}): string | null {
  const fromHeader = parseBrowserId(request.headers.get(BROWSER_ID_HEADER));
  if (fromHeader) return fromHeader;
  try {
    return parseBrowserId(
      new URL(request.url).searchParams.get(BROWSER_ID_QUERY),
    );
  } catch {
    return null;
  }
}
