import { useSyncExternalStore } from "react";
import { desktopShell, type ShellIpc } from "@/lib/desktop/shell";

/**
 * Whether this browser may show OpenBot's notifications: the browser's own answer, never a guess.
 *
 * WHAT A NOTIFICATION IS HERE. The web app raises one when a Bot starts needing the person
 * (`AttentionNotifier` in `bot-profile/attention.tsx`), from the page itself. So it shows while
 * OpenBot is open in a tab, and not once the tab is closed: there is no web push. Onboarding's Get
 * notified step says so rather than promise more.
 *
 * ONE ANSWER FOR THE WHOLE PAGE. Onboarding's step and a Bot's page both offer to turn them on,
 * and a press on either has to show on the other, so the state lives here once and both read it
 * through `useNotificationPermission`.
 *
 * IN OPENBOT DESKTOP the answer is the desktop app's, not the window's. The window is the system's
 * web view, and on macOS its own Notification API cannot be granted: asked, WKWebView answers
 * "denied" at once without a prompt, and reads "default" again at the next launch, so the offer to
 * turn them on came back after every yes. The desktop app shows them through Tauri's notification
 * plugin instead, whose script stands in for `Notification` in the window (`new Notification` posts
 * through the system), and its answer is the plugin's `is_permission_granted`: on a desktop, always
 * yes, since an app needs no permission of its own to post one. That script reads the answer
 * asynchronously and its `Notification.permission` says "default" until then, so it is not read
 * here. A desktop app from before the plugin leaves the window's own answer.
 */
export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  /** No Notification API, as in Safari on iPhone outside a Home Screen app. */
  | "unsupported"
  /** In OpenBot Desktop, until the desktop app has answered. Nothing is offered meanwhile. */
  | "checking";

/** What the browser says now. A browser that throws on reading it is one that cannot show them. */
export function notificationPermission(): NotificationPermissionState {
  try {
    return typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission;
  } catch {
    return "unsupported";
  }
}

/** Tauri's notification plugin, as OpenBot Desktop registers it (desktop/src-tauri). */
const PLUGIN = "plugin:notification";

/**
 * The plugin's `PermissionState` in the browser's words: it says "prompt" (or
 * "prompt-with-rationale") where a browser says "default".
 */
function fromPlugin(state: unknown): NotificationPermissionState {
  return state === "granted" || state === "denied" ? state : "default";
}

/**
 * The desktop app's answer: `is_permission_granted` is true, false, or null while not asked. Null
 * from a desktop app without the plugin (it refuses the command), which leaves the window's.
 */
async function desktopPermission(
  shell: ShellIpc,
): Promise<NotificationPermissionState | null> {
  try {
    const granted = await shell.invoke(`${PLUGIN}|is_permission_granted`);
    return granted === true
      ? "granted"
      : granted === false
        ? "denied"
        : "default";
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let current: NotificationPermissionState | null = null;
/** Counts each fresh read, so an answer the desktop app gives late cannot overwrite a newer one. */
let reading = 0;
/** Settles once the desktop app's answer to the newest read is in, while `current` is "checking". */
let answered: Promise<void> = Promise.resolve();

function read(): NotificationPermissionState {
  if (current !== null) return current;
  const shell = desktopShell();
  if (!shell) {
    current = notificationPermission();
    return current;
  }
  current = "checking";
  const asked = ++reading;
  answered = desktopPermission(shell).then((answer) => {
    if (asked === reading) set(answer ?? notificationPermission());
  });
  return current;
}

function set(next: NotificationPermissionState) {
  current = next;
  for (const listener of listeners) listener();
}

/** Asks the desktop app's plugin, or the browser where there is none. */
async function ask(): Promise<NotificationPermissionState> {
  const shell = desktopShell();
  if (shell) {
    try {
      return fromPlugin(await shell.invoke(`${PLUGIN}|request_permission`));
    } catch {
      // A desktop app without the plugin: the window's own API, below.
    }
  }
  if (notificationPermission() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

/**
 * Asks the browser, which shows its own prompt the first time and answers at once after that.
 * Resolves with the answer; never throws.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (read() === "unsupported") return "unsupported";
  const answer = await ask();
  reading++;
  set(answer);
  return answer;
}

/**
 * Whether a notification may be shown now. In OpenBot Desktop, the desktop app's answer, the one
 * the offer reads: not the plugin script's `Notification.permission`, which stays "default" for as
 * long as the page is open when its own first question went unanswered. In a browser, the browser's,
 * read afresh each time, so a site setting changed meanwhile counts.
 *
 * In OpenBot Desktop the answer comes back over IPC, so the first read after OpenBot starts has
 * none yet ("checking"). This waits for it rather than take that as a no: taken as a no, the first
 * Bot to need the person after each launch raised nothing.
 */
export async function notificationsAllowed(): Promise<boolean> {
  if (!desktopShell()) return notificationPermission() === "granted";
  let state = read();
  while (state === "checking") {
    await answered;
    state = read();
  }
  return state === "granted";
}

/** Reads the browser's answer again, for a "Check again" after somebody changed a site setting. */
export function refreshNotificationPermission() {
  current = null;
  set(read());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The browser's answer, kept current across every component that draws it. */
export function useNotificationPermission(): NotificationPermissionState {
  return useSyncExternalStore(subscribe, read, () => "unsupported" as const);
}
