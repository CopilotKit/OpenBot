import type { Page } from "playwright";
import type { BrowserRuntime } from "./browser-runtime";
import { parseNavigateUrl } from "./request-validation";

type Backend = BrowserRuntime["backend"];
export type PagePurpose = "read" | "navigate";

/** Navigation can leave an unreadable Chrome error/local page, but cannot inspect it. */
export function assertPageAccess(
  backend: Backend,
  url: string,
  purpose: PagePurpose = "read",
): void {
  if (purpose === "navigate") return;
  if (
    backend === "local-chrome" &&
    url !== "about:blank" &&
    !/^https?:\/\//i.test(url)
  ) {
    throw new Error(
      "Local Chrome computer tools can access only web pages. Use the approved host-access tools for local files.",
    );
  }
}

/** Validate the destination before goto and the resulting page before callers read its content. */
export async function navigateWebPage(
  page: Pick<Page, "goto" | "url">,
  url: string,
  backend: Backend,
  timeoutMs: number,
) {
  const parsed = parseNavigateUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  const response = await page.goto(parsed.url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  assertPageAccess(backend, page.url());
  return response;
}

/** The browser's own reasons a page was refused rather than failing to arrive. */
const REFUSED = new Set([
  "ERR_BLOCKED_BY_ADMINISTRATOR",
  "ERR_BLOCKED_BY_CLIENT",
  "ERR_BLOCKED_BY_RESPONSE",
  "ERR_NETWORK_ACCESS_DENIED",
  "ERR_ACCESS_DENIED",
  "ERR_UNSAFE_PORT",
]);

/** How an address is named to a person: the site (with its port, when it has one), else as given. */
function addressForPerson(address: string): string {
  try {
    const url = new URL(address);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host;
  } catch {
    // Not a URL: said as it was asked for.
  }
  return address.length > 80 ? `${address.slice(0, 79)}…` : address;
}

/**
 * Why a page did not open, in one sentence for the person: which address, and that it did not load
 * or was refused.
 *
 * Never Playwright's own message. That one names the method that failed, the browser's error code
 * and Playwright's call log ("goto: net::ERR_ABORTED at … Call log: - navigating to …"),
 * which the person sees under the address bar and can do nothing with. The code still decides the
 * sentence, read out of the message, since Playwright gives it nowhere else.
 */
export function navigationFailure(address: string, error: unknown): string {
  const where = addressForPerson(address);
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError")
    return `${where} did not load in time.`;
  if (/Download is starting/.test(message))
    return `${where} started a download rather than opening a page.`;
  const code = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1];
  if (code === "ERR_CONNECTION_REFUSED")
    return `${where} refused the connection.`;
  if (code && REFUSED.has(code)) return `${where} was refused.`;
  return `${where} did not load.`;
}
