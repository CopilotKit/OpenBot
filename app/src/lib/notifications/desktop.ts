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
