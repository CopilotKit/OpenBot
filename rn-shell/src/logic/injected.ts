/**
 * The script the app puts into the web view before the page's own scripts (react-native-webview's
 * `injectedJavaScriptBeforeContentLoaded`, and again at document end because Android runs the first
 * one from onPageStarted, which is not guaranteed to beat the page). Idempotent per document.
 *
 * In every frame it runs in (all frames on iOS, the main frame on Android): a document that is not
 * the main frame of the app's own origin gets alert, confirm and prompt that do nothing (the native
 * dialog code, patched, also refuses any frame but the main one), and nothing else.
 *
 * In the main frame of the app's own origin only:
 * - the marker the web app reads (`window.__OPENBOT_NATIVE_SHELL__ = {platform, version, bridge: 1}`);
 * - the bridge the web app calls: `window.OpenBotShellAndroid.postMessage(json)`, on BOTH platforms
 *   (app/src/lib/native-shell/bridge.ts tries iOS's `webkit.messageHandlers.openbotShell` first and
 *   falls back to it), forwarded to react-native-webview with this launch's token;
 * - `doc` when the document starts (a commit), `text` once the page shows text (how much in <main>),
 *   `tap` after a touch (Android tells no gesture for a navigation, so a scheme link needs a recent
 *   tap), and `alert` (own-origin alerts are shown natively, titled OpenBot);
 * - a 40 px mostly downward drag that did not start in a text field puts the keyboard away;
 * - `__openbotShellOpen(path)`: the `openbot:open` event the tab bar sends, loading the page itself
 *   when nobody handled it.
 */
export type InjectedOptions = {
  origin: string;
  platform: "ios" | "android";
  version: string;
  token: string;
  /** "start" before the page's scripts; "end" the second chance at document end (a late `doc`). */
  when: "start" | "end";
};

export function injectedScript(options: InjectedOptions): string {
  const own = JSON.stringify(options.origin);
  const marker = JSON.stringify({ platform: options.platform, version: options.version, bridge: 1 });
  const token = JSON.stringify(options.token);
  const hideScrollbars = options.platform === "android";
  return `(function () {
  var OWN = ${own};
  var TOKEN = ${token};
  var top = false;
  try { top = window.top === window; } catch (e) { top = false; }
  var ownOrigin = false;
  try { ownOrigin = location.origin === OWN; } catch (e) { ownOrigin = false; }
  if (!top || !ownOrigin) {
    try {
      window.alert = function () {};
      window.confirm = function () { return false; };
      window.prompt = function () { return null; };
    } catch (e) {}
    return;
  }
  if (window.__openbotShellInstalled) return;
  try { Object.defineProperty(window, "__openbotShellInstalled", { value: true }); } catch (e) { return; }

  function send(message) {
    message.token = TOKEN;
    var text;
    try { text = JSON.stringify(message); } catch (e) { return; }
    try {
      var handlers = window.webkit && window.webkit.messageHandlers;
      if (handlers && handlers.ReactNativeWebView) { handlers.ReactNativeWebView.postMessage(text); return; }
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) window.ReactNativeWebView.postMessage(text);
    } catch (e) {}
  }

  try {
    Object.defineProperty(window, "__OPENBOT_NATIVE_SHELL__", { value: Object.freeze(${marker}), enumerable: true });
  } catch (e) {}
  try {
    Object.defineProperty(window, "OpenBotShellAndroid", {
      value: Object.freeze({
        postMessage: function (json) {
          var parsed;
          try { parsed = typeof json === "string" ? JSON.parse(json) : json; } catch (e) { return; }
          send({ kind: "bridge", message: parsed });
        }
      })
    });
  } catch (e) {}
  try {
    window.alert = function (text) { send({ kind: "alert", message: String(text === undefined ? "" : text) }); };
  } catch (e) {}
  try {
    Object.defineProperty(window, "__openbotShellOpen", {
      value: function (path) {
        var handled = false;
        try {
          handled = !window.dispatchEvent(new CustomEvent("openbot:open", { cancelable: true, detail: { path: path } }));
        } catch (e) { handled = false; }
        send({ kind: "open", handled: handled });
        if (!handled) location.assign(path);
      }
    });
  } catch (e) {}
  send({ kind: "doc", late: ${options.when === "end"} });
${
  hideScrollbars
    ? `  try {
    var style = document.createElement("style");
    style.textContent = "::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}*{scrollbar-width:none!important}";
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}
`
    : ""
}
  // The page's background and light or dark style, for the strips the app draws around it.
  var lastChrome = "";
  function chrome() {
    try {
      var b = document.body, h = document.documentElement;
      if (!b || !h) return;
      var css = getComputedStyle(b).backgroundColor;
      if (!css || css === "transparent" || css === "rgba(0, 0, 0, 0)") css = getComputedStyle(h).backgroundColor;
      var canvas = document.createElement("canvas");
      canvas.width = 1; canvas.height = 1;
      var x = canvas.getContext("2d");
      x.fillStyle = "rgba(0,0,0,0)"; x.fillStyle = css; x.fillRect(0, 0, 1, 1);
      var d = x.getImageData(0, 0, 1, 1).data;
      if (d[3] < 255) return;
      var hex = "#" + [d[0], d[1], d[2]].map(function (n) { return (n < 16 ? "0" : "") + n.toString(16); }).join("");
      var dark = h.classList.contains("dark");
      var key = hex + dark;
      if (key === lastChrome) return;
      lastChrome = key;
      send({ kind: "chrome", color: hex, dark: dark });
    } catch (e) {}
  }
  function watchChrome() {
    chrome();
    try { new MutationObserver(chrome).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] }); } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchChrome);
  else watchChrome();
  window.addEventListener("load", chrome);

  // Text on the page: once there is any, and once <main> has 20 characters.
  var sentBody = false, sentMain = false, polls = 0;
  function measure() {
    polls += 1;
    try {
      var body = document.body ? (document.body.innerText || "").trim().length : 0;
      var mainNode = document.querySelector("main") || document.body;
      var main = mainNode ? (mainNode.innerText || "").trim().length : 0;
      if ((body > 0 && !sentBody) || (main >= 20 && !sentMain)) {
        sentBody = sentBody || body > 0;
        sentMain = sentMain || main >= 20;
        send({ kind: "text", body: body, main: main });
      }
    } catch (e) {}
    if (!sentMain && polls < 75) setTimeout(measure, 200);
  }
  setTimeout(measure, 100);

  function isTextField(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable || node.tagName === "TEXTAREA") return true;
    if (node.tagName !== "INPUT") return false;
    return ["button", "checkbox", "color", "file", "radio", "range", "reset", "submit", "image", "hidden"].indexOf((node.type || "").toLowerCase()) < 0;
  }
  var start = null, lastTapSent = 0;
  document.addEventListener("touchstart", function (event) {
    var touch = event.touches && event.touches[0];
    start = touch ? { x: touch.clientX, y: touch.clientY, field: isTextField(event.target), done: false } : null;
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", function (event) {
    var touch = event.touches && event.touches[0];
    if (!start || start.done || start.field || !touch) return;
    var dy = touch.clientY - start.y, dx = Math.abs(touch.clientX - start.x);
    if (dy > 40 && dy > 2 * dx) {
      start.done = true;
      var focused = document.activeElement;
      if (isTextField(focused)) focused.blur();
    }
  }, { capture: true, passive: true });
  function tapped() {
    var now = Date.now();
    if (now - lastTapSent < 300) return;
    lastTapSent = now;
    send({ kind: "tap" });
  }
  document.addEventListener("touchend", tapped, { capture: true, passive: true });
  document.addEventListener("click", tapped, { capture: true, passive: true });
})();
true;`;
}

/** Puts the keyboard away from the page's side: the focused field loses the focus. */
export const BLUR_SCRIPT =
  "(function(){try{var f=document.activeElement;if(f&&f.blur&&f!==document.body)f.blur();}catch(e){}})(); true;";
