/*
 * OpenBot's service worker: it shows the push notifications the server sends to a browser the
 * person turned them on in (Settings, Notifications), and opens OpenBot where one points when it
 * is clicked. It does nothing else. It answers no fetch, so every request goes to the network as
 * if it were not here, and it caches nothing.
 *
 * THE PAYLOAD is Declarative Web Push (https://webkit.org/blog/16535/meet-declarative-web-push/),
 * so the same message shows by itself on an iPhone or iPad on iOS 18.4 or later and through this
 * worker everywhere else:
 *
 *   { "web_push": 8030,
 *     "notification": { "title", "body", "navigate", "lang", "dir", "tag", "silent" } }
 *
 * `navigate` is where a click goes. Only an address of this OpenBot is opened; anything else opens
 * OpenBot's home.
 *
 * Plain JavaScript in public/, served as it is at /sw.js so its scope is the whole app. The app
 * registers it (lib/web-push/browser.ts) and the page test drives it in a real browser
 * (tests/web-push-browser.test.tsx).
 */

/** What a push shows when its payload is not one OpenBot sends. */
const FALLBACK_TITLE = "OpenBot";

/** The app's icon, which the manifest names too. */
const ICON = "/icon-192.png";

/**
 * Where a notification's click goes: `navigate` when it is an address of this OpenBot, else
 * OpenBot's home. Never another site, and never a script.
 */
function destinationOf(navigate, origin) {
  if (typeof navigate !== "string" || navigate === "") return `${origin}/`;
  let url;
  try {
    url = new URL(navigate, origin);
  } catch {
    return `${origin}/`;
  }
  if (url.origin !== origin) return `${origin}/`;
  return url.href;
}

/**
 * The notification a push shows, from its payload's text: its title and the options
 * showNotification takes. A payload that is not OpenBot's still shows a notification, since a
 * browser counts a push that shows nothing against the site.
 */
function notificationOf(text, origin) {
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const notification =
    payload && typeof payload === "object" && payload.notification
      ? payload.notification
      : {};
  const title =
    typeof notification.title === "string" && notification.title !== ""
      ? notification.title
      : FALLBACK_TITLE;
  const options = {
    body: typeof notification.body === "string" ? notification.body : "",
    icon: ICON,
    data: { navigate: destinationOf(notification.navigate, origin) },
  };
  if (typeof notification.tag === "string" && notification.tag !== "")
    options.tag = notification.tag;
  if (typeof notification.lang === "string") options.lang = notification.lang;
  if (
    notification.dir === "auto" ||
    notification.dir === "ltr" ||
    notification.dir === "rtl"
  )
    options.dir = notification.dir;
  if (typeof notification.silent === "boolean")
    options.silent = notification.silent;
  return { title, options };
}

/** Shows the notification a push carries. */
function showPush(event) {
  const text = event.data ? event.data.text() : "";
  const { title, options } = notificationOf(text, self.location.origin);
  return self.registration.showNotification(title, options);
}

/**
 * Opens OpenBot where a clicked notification points: in a window of OpenBot already open, which
 * comes to the front and moves there in place (the app's router, told by a message), or else in a
 * new one.
 */
async function openFrom(notification) {
  const origin = self.location.origin;
  const destination = destinationOf(notification.data?.navigate, origin);
  const url = new URL(destination);
  const path = url.pathname + url.search + url.hash;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const open = windows
    .filter((client) => new URL(client.url).origin === origin)
    .sort((a, b) => Number(b.focused) - Number(a.focused))[0];
  if (open) {
    try {
      await open.focus();
    } catch {
      // A browser that won't bring it forward: it still moves to the page.
    }
    open.postMessage({ type: "openbot:open", path });
    return;
  }
  await self.clients.openWindow(destination);
}

/**
 * The browser renewed or ended the subscription. Subscribe again with the same key where the
 * browser did not already, and ask an open page to save it now. A page saves this browser's
 * subscription every time OpenBot starts, so the next start saves it if no page is open.
 */
async function resubscribe(event) {
  let subscription = event.newSubscription ?? null;
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!subscription && key) {
    subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  }
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) client.postMessage({ type: "openbot:resave" });
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openFrom(event.notification));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event).catch(() => undefined));
});

/** For the page test, which can't click a notification in a headless browser. */
self.openbotNotifications = { destinationOf, notificationOf, openFrom };
