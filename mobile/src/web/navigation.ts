/**
 * Where the web view may go, and where a tap on a notification takes it.
 *
 * Imports nothing that needs a phone, so it can be tested.
 */
import { notificationDestination } from "../links";

/**
 * What the web view does with an address it is asked to load.
 *
 * - `load`: it loads it. Every web address is loaded where it was asked for, because a sign-in leaves the web
 *   app for the page that signs the person in and comes back.
 * - `outside`: the phone opens it: a mail address, a phone number, another app.
 * - `purchase`: a page where a plan is paid for. The app does not open it (PURCHASE_PATHS).
 * - `blocked`: nothing happens.
 */
export type NavigationVerdict = "load" | "outside" | "purchase" | "blocked";

/**
 * The web app's addresses that start a payment: adding a card for the plan, and adding a seat. An app from the
 * App Store or Google Play may not sell a plan through a web page, or point at one, so the app never opens them
 * and hides the links to them (./bridge.ts). A plan is managed in a browser.
 */
export const PURCHASE_PATHS = [
  "/api/auth/hosted/checkout",
  "/api/auth/hosted/add-seat",
] as const;

/**
 * Where those two send the browser, on the address of OpenBot by CopilotKit's own pages: the card page and the
 * seats page. Refused on any address, should a page link to one directly.
 */
const PAYMENT_PAGES = ["/openbot/checkout", "/openbot/seats"];

/** Where the card is typed, should a page reach one another way. */
const PAYMENT_HOSTS = ["checkout.stripe.com", "buy.stripe.com"];

/** What only a page draws: a frame's own content, never an address a person is sent to. */
const INLINE = ["about:", "blob:", "data:"];

export function navigationVerdict(
  address: string,
  webOrigin: string,
): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "blocked";
  }
  if (INLINE.includes(url.protocol)) return "load";
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (PAYMENT_HOSTS.includes(url.hostname)) return "purchase";
    if (PAYMENT_PAGES.includes(url.pathname)) return "purchase";
    if (
      url.origin === webOrigin &&
      PURCHASE_PATHS.some((path) => url.pathname === path)
    )
      return "purchase";
    return "load";
  }
  // The app's own links are for notifications, which the app reads itself. A page has no use for one.
  if (url.protocol === "javascript:" || url.protocol === "openbotmobile:")
    return "blocked";
  return "outside";
}

/** The web app's pages a notification opens. tests/web-navigation.test.ts holds them to the web app's routes. */
export const CONVERSATION_ROUTE = "/channel/$channelId";
export const APPROVALS_PAGE = "/settings/approvals";

/**
 * The page a tap on a notification opens, read from the link the server put in it (../links.ts): the
 * conversation it is about, or the approvals inbox. Null for a notification that names no known screen.
 */
export function webDestination(
  webOrigin: string,
  notification: unknown,
): string | null {
  const destination = notificationDestination(notification);
  if (!destination) return null;
  if (destination.pathname === "/conversation")
    return `${webOrigin}/channel/${encodeURIComponent(destination.params.channelId)}`;
  return `${webOrigin}${APPROVALS_PAGE}`;
}
