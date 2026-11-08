import type { ShellIpc } from "@/lib/desktop/shell";

/**
 * NOTIFICATIONS IN THE OPENBOT DESKTOP WINDOW, AS THE PAGE SEES THEM.
 *
 * Two things stand in for `Notification` there, depending on the desktop app:
 *
 * - The window's own, before the desktop app carried Tauri's notification plugin (0.3.3 and
 *   earlier). MEASURED in a WKWebView set up as wry sets one up (a UI delegate with no notification
 *   method), loaded from http://127.0.0.1: `Notification.permission` is "default",
 *   `requestPermission()` answers "denied" at once with no prompt, `permission` then reads "denied",
 *   and a second launch reads "default" again.
 * - Since then, the plugin's script, which Tauri runs in the window on every page load before the
 *   page's own scripts, and which replaces `window.Notification`. `PLUGIN_SCRIPT` is that script as
 *   tauri-plugin-notification 2.8.0 ships it (src/init-iife.js), byte for byte; Tauri replaces
 *   `__TEMPLATE_windows__` with `false` on macOS (src/lib.rs). The commands it calls answer as the
 *   plugin's desktop side does (src/desktop.rs: "Desktop applications do not need to ask for this
 *   permission, so this always resolves to Granted"), and as the shell's test
 *   `only_the_owned_app_origin_can_turn_on_and_show_notifications` pins they do for OpenBot's page.
 */
const PLUGIN_SCRIPT =
  '!function(){"use strict";async function i(i,n={},t){return window.__TAURI_INTERNALS__.invoke(i,n,t)}"function"==typeof SuppressedError&&SuppressedError,function(){let n=!1,t="default";function o(i){n=!0,window.Notification.permission=i,n=!1}window.Notification=function(n,t){const o=t||{};!async function(n){"object"==typeof n&&Object.freeze(n),await i("plugin:notification|notify",{options:"string"==typeof n?{title:n}:n})}(Object.assign(o,{title:n}))},window.Notification.requestPermission=async function(){return await i("plugin:notification|request_permission").then(i=>(o("prompt"===i||"prompt-with-rationale"===i?"default":i),i))},Object.defineProperty(window.Notification,"permission",{enumerable:!0,get:()=>t,set:i=>{if(!n)throw new Error("Readonly property");t=i}}),async function(){return"default"!==window.Notification.permission?await Promise.resolve("granted"===window.Notification.permission):!!__TEMPLATE_windows__||await i("plugin:notification|is_permission_granted")}().then(function(i){o(null===i?"default":i?"granted":"denied")})}()}();';

export type DesktopCall = { command: string; args?: Record<string, unknown> };

type Globals = {
  __TAURI_INTERNALS__?: ShellIpc;
  Notification?: unknown;
};

/** WKWebView's own `Notification` in the Desktop window, as measured: it can only say no. */
function windowNotification() {
  let permission: NotificationPermission = "default";
  return {
    get permission() {
      return permission;
    },
    requestPermission: async () => {
      permission = "denied";
      return permission;
    },
  };
}

/**
 * Opens OpenBot's page in the Desktop window: Tauri's IPC, the window's own `Notification`, and,
 * when the desktop app carries it, the notification plugin's script over it. Each call is a launch:
 * the window's answer starts over, as WKWebView's does.
 */
export function launchDesktop(options: { plugin: boolean }) {
  const calls: DesktopCall[] = [];
  let nextCallback = 1;
  const shell: ShellIpc = {
    transformCallback: () => nextCallback++,
    async invoke(command, args) {
      calls.push({ command, args });
      const [plugin, name] = command.replace("plugin:", "").split("|");
      if (plugin !== "notification") return null;
      // Tauri refuses a command of a plugin it does not have with a string, not an Error.
      if (!options.plugin)
        throw `notification.${name} not allowed. Plugin not found`;
      switch (name) {
        case "is_permission_granted":
          return true;
        case "request_permission":
          return "granted";
        case "notify":
          return null;
        default:
          throw `notification.${name} not allowed. Command not found`;
      }
    },
  };
  // The page reads both through `window` and as bare globals; in a browser they are one object.
  for (const scope of new Set<Globals>([
    window as unknown as Globals,
    globalThis as Globals,
  ])) {
    scope.__TAURI_INTERNALS__ = shell;
    scope.Notification = windowNotification();
  }
  if (options.plugin) {
    new Function(
      "window",
      PLUGIN_SCRIPT.replace("__TEMPLATE_windows__", "false"),
    )(globalThis);
    (window as unknown as Globals).Notification = (
      globalThis as Globals
    ).Notification;
  }
  return {
    calls,
    /** What the page asked the system to show, in the order it asked. */
    shown: () =>
      calls
        .filter((call) => call.command === "plugin:notification|notify")
        .map((call) => call.args?.options),
  };
}

export function closeDesktop() {
  for (const scope of [window as unknown as Globals, globalThis as Globals]) {
    delete scope.__TAURI_INTERNALS__;
    delete scope.Notification;
  }
}
