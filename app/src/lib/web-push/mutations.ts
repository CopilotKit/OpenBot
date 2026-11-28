import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteWebPushSubscription,
  saveWebPushSubscription,
} from "@/lib/api/generated/web-push/web-push";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import {
  type NotificationPermissionState,
  notificationPermission,
} from "@/lib/notifications/permission";
import {
  browserSubscriptionId,
  keyBytes,
  madeWithKey,
  registerWorker,
  subscriptionBody,
  webPushSupport,
  workerRegistration,
} from "./browser";
import { webPushKeyQueryOptions, webPushKeys } from "./queries";

/**
 * Turning push notifications on and off in this browser, and keeping the server's copy of its
 * subscription current. The person's own (`me`), in the organization they are working in.
 */

const ME = "me";
const FALLBACK =
  "Couldn't turn on notifications in this browser. Try again in a moment.";
const OFF_FALLBACK =
  "Couldn't turn off notifications in this browser. Try again in a moment.";

/** Said when the browser's prompt was closed without an answer. */
export const NOT_ALLOWED =
  "Notifications are still off. Turn this on again and choose Allow.";

/** Said when the browser refuses to subscribe, as one with its push service switched off does. */
export const COULD_NOT_SUBSCRIBE =
  "This browser couldn't turn on notifications. Try again in a moment.";

/** How long signing out waits for this browser's subscription to be removed before going on. */
const SIGN_OUT_WAIT_MS = 3_000;

/**
 * This browser's subscription, made with OpenBot's key: the one it holds when that was made with the
 * key, else a new one. One made with another key can't be sent to, so it is ended first.
 */
async function subscribed(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  const held = await registration.pushManager.getSubscription();
  if (held && madeWithKey(held, publicKey)) return held;
  if (held) await held.unsubscribe();
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
}

/** Saves this browser's subscription on the server, replacing what it held for this browser. */
async function save(subscription: PushSubscription): Promise<void> {
  await saveWebPushSubscription(
    organizationId(),
    ME,
    browserSubscriptionId(),
    subscriptionBody(subscription),
    { "Idempotency-Key": idempotencyKey() },
    { fallback: FALLBACK },
  );
}

/** Removes this browser's subscription from the server. One already gone is done. */
async function remove(): Promise<void> {
  try {
    await deleteWebPushSubscription(
      organizationId(),
      ME,
      browserSubscriptionId(),
      { "Idempotency-Key": idempotencyKey() },
      { fallback: OFF_FALLBACK },
    );
  } catch (error) {
    if (error instanceof ClientError && error.status === 404) return;
    throw error;
  }
}

/**
 * Turns push notifications on in this browser. Takes the browser's answer to its permission prompt,
 * asked by the caller in the press itself (`requestNotificationPermission`): Safari shows the prompt
 * only from a person's tap, and a tap's turn is over by the time a mutation runs.
 *
 * Then registers the service worker, subscribes with OpenBot's key and saves the subscription. A
 * subscription the server could not save is ended again, so the switch never says on for a browser
 * OpenBot doesn't send to.
 */
export function turnOnWebPushMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      asked: Promise<NotificationPermissionState>,
    ): Promise<void> => {
      if ((await asked) !== "granted") throw new Error(NOT_ALLOWED);
      let subscription: PushSubscription;
      const publicKey = await queryClient.fetchQuery(webPushKeyQueryOptions());
      try {
        subscription = await subscribed(await registerWorker(), publicKey);
      } catch {
        throw new Error(COULD_NOT_SUBSCRIBE);
      }
      try {
        await save(subscription);
      } catch (error) {
        await subscription.unsubscribe().catch(() => false);
        throw error;
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: webPushKeys.thisBrowser }),
  });
}

/**
 * Turns push notifications off in this browser: the server stops sending to it, then the browser
 * ends its subscription. A removal the server refused leaves the subscription as it was, so the
 * switch stays on and says so.
 */
export function turnOffWebPushMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      const registration = await workerRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      await remove();
      await subscription?.unsubscribe();
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: webPushKeys.thisBrowser }),
  });
}

/**
 * Saves this browser's subscription again, each time OpenBot starts in an organization and when
 * the service worker says the browser renewed it. Saving again is harmless, and it is how a
 * subscription the browser renewed, or one made with a key that has since changed, reaches the
 * server. Also fetches the newest service worker.
 *
 * Nothing when notifications are off here. Never throws to its caller's harm: a start that could
 * not save tries again at the next one, and the switch still reads the browser's own state.
 */
export async function keepThisBrowserSaved(
  queryClient: QueryClient,
): Promise<void> {
  if (
    webPushSupport() !== "supported" ||
    notificationPermission() !== "granted"
  )
    return;
  const registration = await workerRegistration();
  if (!registration) return;
  await registration.update().catch(() => undefined);
  if (!(await registration.pushManager.getSubscription())) return;
  const publicKey = await queryClient.fetchQuery(webPushKeyQueryOptions());
  await save(await subscribed(registration, publicKey));
  await queryClient.invalidateQueries({ queryKey: webPushKeys.thisBrowser });
}

/**
 * On signing out: the server stops sending to this browser and the browser ends its subscription,
 * so whoever signs in next is not sent the last person's notifications. Never throws, and never
 * holds the sign-out up for long: a removal that can't finish in time is left, and the push service
 * refuses the ended subscription when the server next sends to it, which removes it there too.
 */
export async function forgetThisBrowser(): Promise<void> {
  if (webPushSupport() !== "supported") return;
  const forgetting = (async () => {
    const registration = await workerRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await remove().catch(() => undefined);
    await subscription.unsubscribe();
  })().catch(() => undefined);
  await Promise.race([
    forgetting,
    new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS)),
  ]);
}
