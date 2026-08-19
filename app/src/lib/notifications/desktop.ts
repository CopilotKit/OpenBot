import type { BotNotification } from "./waiting";

/**
 * The operating system's own notification, behind an opt-in nobody is asked for.
 *
 * A browser permission prompt on load is the single most disliked thing a web application does, and
 * it is also self-defeating: asked before they know what the product is for, most people press
 * Block, and Block is permanent enough that the feature is then gone for good. So nothing here runs
 * until somebody turns the switch on, and the switch is the only thing that asks.
 *
 * The preference is stored in this browser rather than on the person's account, because the thing it
 * governs is granted per browser. A server-side "yes" that this browser has never granted would be a
 * promise the product cannot keep, and somebody would trust it and miss a Bot waiting on them. On a
 * new machine the switch is off and the answer is honest: this browser has not been asked yet.
 */

export const DESKTOP_NOTIFICATIONS_STORAGE_KEY =
  "openbot-desktop-notifications";

/** Off unless this browser was explicitly turned on. Anything else reads as off. */
export function parseDesktopNotificationsPreference(
  value: string | null,
): boolean {
  return value === "on";
}

/**
 * What happened when somebody asked for desktop notifications.
 *
 * `unsupported` is separate from `denied` because they need different sentences. Denied is a
 * decision this person made and can revisit in their browser; unsupported is a browser that has
 * nothing to revisit, and telling them to check their settings would send them looking for a control
 * that is not there.
 */
export type DesktopPermission = "granted" | "denied" | "unsupported";

/** The answers that are not "granted", which are the ones a person has to be told about. */
export type DesktopRefusal = Exclude<DesktopPermission, "granted">;

type PermissionApi = {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

function permissionApi(): PermissionApi | null {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return {
    permission: Notification.permission,
    requestPermission: () => Notification.requestPermission(),
  };
}

/**
 * Ask for permission, once, because somebody just asked for this.
 *
 * Only ever called from the switch. Every other path in the product reads the answer and never asks
 * for it, so there is exactly one place a prompt can come from and it is one the person opened.
 */
export async function requestDesktopNotifications(
  api: PermissionApi | null = permissionApi(),
): Promise<DesktopPermission> {
  if (!api) return "unsupported";
  if (api.permission === "granted") return "granted";
  // A browser that has already been told no does not show the prompt again; asking anyway resolves
  // immediately with the old answer, so this needs no special case beyond reporting it honestly.
  const answer = await api.requestPermission();
  return answer === "granted" ? "granted" : "denied";
}

/** Where the switch may honestly sit. */
export type DesktopNotificationsState = {
  enabled: boolean;
  /**
   * Why it is off, when somebody had asked for it to be on.
   *
   * Null when nothing was withdrawn, which covers both "off because nobody turned it on" and "on and
   * working". A sentence about a blocked browser in front of somebody who never asked for
   * notifications would be an answer to a question they did not put.
   */
  withdrawn: DesktopRefusal | null;
};

/**
 * Settle what was asked for against what the browser will still do.
 *
 * The stored preference is not the answer on its own. A grant can be taken away long after it was
 * given — somebody revokes it in site settings, or clears the profile, or the browser expires it —
 * and none of that comes back through the tab that asked for it. Reading only what was stored leaves
 * a switch sitting at "on" while `showDesktopNotification` quietly returns at its permission check,
 * which is the one failure this control must not have: somebody trusts it, is not told, and misses
 * the Bot that was waiting for them.
 *
 * Takes the stored preference rather than reading it, and takes the permission API rather than
 * reaching for it, so the rule can be argued with in a test rather than only in a browser.
 */
export function reconcileDesktopNotifications(
  stored: boolean,
  api: PermissionApi | null = permissionApi(),
): DesktopNotificationsState {
  if (!stored) return { enabled: false, withdrawn: null };
  if (!api) return { enabled: false, withdrawn: "unsupported" };
  if (api.permission === "granted") return { enabled: true, withdrawn: null };
  return { enabled: false, withdrawn: "denied" };
}

/**
 * Show one, if this browser is allowed to and this person asked for it.
 *
 * Silently does nothing otherwise. The toast has already appeared and the sidebar marker is already
 * set, so this is the third of three ways the same fact is being told; failing loudly about the one
 * that is a nicety would be out of proportion.
 */
export function showDesktopNotification(
  botName: string,
  notification: BotNotification,
): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(`${botName} ${notification.headline}`, {
      body: notification.detail,
      // Tagged by Bot, so a Bot that asks twice replaces its own notification rather than stacking
      // two of them in the corner of somebody's screen saying the same thing.
      tag: `openbot-waiting-${notification.botId}`,
    });
  } catch {
    // Some browsers refuse construction outside a service worker even with permission granted. The
    // toast is the surface that always works; this one is allowed to be absent.
  }
}
