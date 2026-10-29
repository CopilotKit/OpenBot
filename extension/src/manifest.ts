export type BuildVariant = "release" | "e2e";
// The highest floor of the APIs the Recorder uses: debugger flattened child sessions (sessionId) need 125.
// The others sit lower: offscreen 109, externally_connectable 107, chrome.alarms (below the floor),
// service-worker keep-alive by WebSocket 116 and by debugger 118, scripting world MAIN 95 and injectImmediately 102,
// storage setAccessLevel 102, String.isWellFormed 111.
// https://developer.chrome.com/docs/extensions/reference/api/debugger
// https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
// https://developer.chrome.com/docs/extensions/reference/api/scripting
// https://developer.chrome.com/docs/extensions/reference/api/storage
// https://developer.chrome.com/docs/extensions/reference/api/offscreen
// https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable
// https://developer.chrome.com/docs/extensions/reference/api/alarms
export const MINIMUM_CHROME_VERSION = "125";
const PERMISSIONS = [
  "storage",
  "unlimitedStorage",
  "alarms",
  "offscreen",
  "debugger",
  "scripting",
  "webNavigation",
  "nativeMessaging",
] as const; // alarms: the organization sign-in keep-alive (Decision 2); unlimitedStorage: Decision 7

/** The same for every build variant: the e2e build differs only in the test hooks its code keeps (see verify-dist). */
export function buildManifest(input: {
  version: string;
  publicKey: string;
}): chrome.runtime.ManifestV3 {
  const icons = {
    "16": "icons/16.png",
    "32": "icons/32.png",
    "48": "icons/48.png",
    "128": "icons/128.png",
  };
  return {
    manifest_version: 3,
    name: "OpenBot Recorder",
    version: input.version,
    description:
      "Record a task in your browser so an OpenBot Bot can learn to do it.",
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    incognito: "not_allowed",
    icons,
    action: {
      default_title: "OpenBot Recorder",
      default_popup: "popup.html",
      default_icon: icons,
    },
    background: { service_worker: "service-worker.js", type: "module" },
    options_page: "options.html",
    permissions: [...PERMISSIONS],
    // Granted at install, so neither Connect nor the first Record has to ask. The debugger permission already implies
    // access to every site, so Chrome and Edge show the same install warnings with or without it ("Read and change all
    // your data on all websites", "Access the page debugger backend", "Communicate with cooperating native
    // applications"), and an update that adds it is no privilege increase that disables the extension.
    // https://developer.chrome.com/docs/extensions/reference/permissions-list
    host_permissions: ["<all_urls>"],
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
