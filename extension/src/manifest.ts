export type BuildVariant = "release" | "e2e";
// The highest floor of the APIs the Recorder uses: debugger flattened child sessions (sessionId) need 125.
// The others sit lower: offscreen 109, tabCapture stream id from a service worker into an offscreen document 116,
// service-worker keep-alive by WebSocket 116 and by debugger 118, scripting world MAIN 95 and injectImmediately 102,
// storage setAccessLevel 102, String.isWellFormed 111.
// https://developer.chrome.com/docs/extensions/reference/api/debugger
// https://developer.chrome.com/docs/extensions/reference/api/tabCapture
// https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
// https://developer.chrome.com/docs/extensions/reference/api/scripting
// https://developer.chrome.com/docs/extensions/reference/api/storage
export const MINIMUM_CHROME_VERSION = "125";
export const PERMISSIONS = [
  "storage", "unlimitedStorage", "alarms", "offscreen", "tabCapture", "debugger", "scripting", "webNavigation", "nativeMessaging",
] as const;   // alarms: the organization sign-in keep-alive (Decision 2); unlimitedStorage: Decision 7

export function buildManifest(input: {
  variant: BuildVariant;
  version: string;
  publicKey: string;
}): chrome.runtime.ManifestV3 {
  const icons = { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" };
  return {
    manifest_version: 3,
    name: "OpenBot Recorder",
    version: input.version,
    description: "Record a task in your browser so an OpenBot Bot can learn to do it.",
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    incognito: "not_allowed",
    icons,
    action: { default_title: "OpenBot Recorder", default_popup: "popup.html", default_icon: icons },
    background: { service_worker: "service-worker.js", type: "module" },
    options_page: "options.html",
    permissions: [...PERMISSIONS],
    ...(input.variant === "e2e"
      ? { host_permissions: ["<all_urls>"] }
      : { optional_host_permissions: ["<all_urls>"] }),
    externally_connectable: { matches: ["<all_urls>"] },
    storage: { managed_schema: "managed_schema.json" },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    // One fixed id in Chrome and Edge, unpacked or policy-installed (Decision 9). A packed CRX gets its id
    // from its signing key, so a company CRX is signed with the matching private key (Task 22).
    key: input.publicKey,
  };
}
