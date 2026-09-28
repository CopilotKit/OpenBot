import {
  BROWSER_ID_HEADER,
  BROWSER_ID_QUERY,
  parseBrowserId,
} from "../../../shared/browser-identity";
import { newId } from "./new-id";

/**
 * Which browser this tab is, remembered across reloads.
 *
 * Used only while the deployment has no sign-in: the server treats this id as the person, so two
 * people on the same deployment keep separate chats. It is not a secret, and clearing the site
 * data starts a new person.
 */

export const BROWSER_ID_STORAGE_KEY = "openbot.browser-id";

let remembered: string | undefined;

export function parseStoredBrowserId(value: string | null): string | null {
  return parseBrowserId(value);
}

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return parseStoredBrowserId(
      window.localStorage.getItem(BROWSER_ID_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function writeStored(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BROWSER_ID_STORAGE_KEY, id);
  } catch {
    // Storage can be unavailable. The in-memory copy still isolates this tab.
  }
}

/**
 * The id this browser sends on every request.
 *
 * Minted once, then reused. A tab that cannot reach localStorage still gets an id for the
 * session, so two people in private windows do not fall back to sharing the deployment's
 * leftover chats.
 */
export function getBrowserId(): string {
  if (remembered) return remembered;
  const stored = readStored();
  if (stored) {
    remembered = stored;
    return stored;
  }
  const id = newId();
  remembered = id;
  writeStored(id);
  return id;
}

export function browserIdentityHeaders(): Record<string, string> {
  return { [BROWSER_ID_HEADER]: getBrowserId() };
}

/** Attach the identity to fetch headers without dropping ones the caller already set. */
export function applyBrowserIdentityHeaders(headers: Headers): Headers {
  headers.set(BROWSER_ID_HEADER, getBrowserId());
  return headers;
}

/**
 * Identify a WebSocket the way HTTP requests use the header.
 *
 * `new WebSocket()` cannot set headers, so the same id rides on the query string the server
 * already accepts as a fallback.
 */
export function withBrowserIdentityQuery(url: string): string {
  const next = new URL(url);
  next.searchParams.set(BROWSER_ID_QUERY, getBrowserId());
  return next.toString();
}
