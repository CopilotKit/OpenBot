import type { SaveWebPushSubscriptionRequest } from "@/lib/api/generated/model";
import { desktopShell } from "@/lib/desktop/shell";
import { newId } from "@/lib/new-id";

/**
 * Web push in this browser: what it supports, its service worker, and the subscription it holds.
 * Asked of the browser, never of the server. What the server keeps is in queries.ts and
 * mutations.ts beside this.
 *
 * Push notifications reach a browser through its own push service (Apple's, Google's, Mozilla's or
 * Microsoft's), even with OpenBot closed, and show through the service worker at /sw.js
 * (app/public/sw.js). The in-page notices a tab raises while OpenBot is open
 * (lib/notifications/show.ts) are separate, and work without any of this.
 */

/** The service worker, at the root so its scope is the whole app. */
export const WEB_PUSH_WORKER = "/sw.js";

/** Where this browser keeps the id it saves its subscription under. */
const ID_STORAGE_KEY = "openbot-web-push-id";

/**
 * Whether this browser can get push notifications:
 *
 * - `supported`: it has a service worker, the Push API and notifications, as Chrome, Edge, Firefox
 *   and Safari on a Mac do, and OpenBot on an iPhone or iPad opened from the Home Screen.
 * - `home-screen-first`: Safari on an iPhone or iPad, which offers them only to a web app added to
 *   the Home Screen, on iOS 16.4 or later. The person is told how, since a switch here can't work.
 * - `newer-ios-first`: OpenBot opened from the Home Screen of an iPhone or iPad older than iOS 16.4.
 * - `unsupported`: anything else, OpenBot Desktop's window included, which shows notifications
 *   through the desktop app. Nothing is offered.
 *
 * The Push API is offered only to a secure page (HTTPS, or this computer's own address), so an
 * OpenBot opened at a plain-HTTP address is `unsupported` too.
 */
export type WebPushSupport =
  | "supported"
  | "home-screen-first"
  | "newer-ios-first"
  | "unsupported";

export function webPushSupport(): WebPushSupport {
  if (typeof window === "undefined" || desktopShell() !== null)
    return "unsupported";
  if (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
    return "supported";
  if (!onAppleMobile() || !window.isSecureContext) return "unsupported";
  // Opened from the Home Screen and still without the Push API: an iOS before 16.4.
  return openedFromHomeScreen() ? "newer-ios-first" : "home-screen-first";
}

/**
 * An iPhone, iPod or iPad. An iPad asks for the desktop site and names itself a Mac, so a "Mac"
 * with a touch screen is one too.
 */
export function onAppleMobile(): boolean {
  const agent = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(agent) ||
    (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
  );
}

/** Opened from the Home Screen as an app of its own, not in a browser's tab. */
export function openedFromHomeScreen(): boolean {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // No matchMedia: only Safari's own flag says.
  }
  return (navigator as { standalone?: boolean }).standalone === true;
}

/** The id kept in this tab when the browser keeps nothing (private browsing that refuses storage). */
let unkeptId: string | undefined;

/**
 * The id this browser's subscription is saved under: made once and kept, so saving again replaces
 * what the server holds for this browser instead of adding another.
 */
export function browserSubscriptionId(): string {
  try {
    const kept = window.localStorage.getItem(ID_STORAGE_KEY);
    if (kept) return kept;
    const made = newId();
    window.localStorage.setItem(ID_STORAGE_KEY, made);
    return made;
  } catch {
    unkeptId ??= newId();
    return unkeptId;
  }
}

/** The server's key, URL-safe base64 without padding, as the bytes the Push API compares. */
export function keyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
  return bytes;
}

/**
 * Whether `subscription` was made with this key. One made with another (a server whose key was
 * replaced, or a different OpenBot at this address before) can't be sent to, so it is replaced.
 */
export function madeWithKey(
  subscription: PushSubscription,
  publicKey: string,
): boolean {
  const held = subscription.options?.applicationServerKey;
  if (!held) return false;
  const a = new Uint8Array(held);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

/**
 * What the server saves: the address and the two keys, from the subscription's own `toJSON()`, and
 * nothing else (the API takes no `expirationTime`).
 */
export function subscriptionBody(
  subscription: PushSubscription,
): SaveWebPushSubscriptionRequest {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth)
    throw new Error("The browser's subscription has no address or keys.");
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** The service worker's registration, when OpenBot has registered it in this browser. */
export async function workerRegistration(): Promise<
  ServiceWorkerRegistration | undefined
> {
  return navigator.serviceWorker.getRegistration("/");
}

/**
 * Registers the service worker, or checks the one there for an update, and waits until it is the
 * active one. Its script is never taken from the HTTP cache, so a new release's reaches the browser
 * at once.
 */
export async function registerWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(WEB_PUSH_WORKER, {
    scope: "/",
    updateViaCache: "none",
  });
  return navigator.serviceWorker.ready;
}
