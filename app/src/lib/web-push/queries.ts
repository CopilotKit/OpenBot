import { queryOptions } from "@tanstack/react-query";
import { getWebPushKey } from "@/lib/api/generated/web-push/web-push";
import { organizationId } from "@/lib/api/request";
import { notificationPermission } from "@/lib/notifications/permission";
import { webPushSupport, workerRegistration } from "./browser";

/**
 * Web push for this browser: the key it subscribes with, from the server, and whether it holds a
 * subscription, from the browser itself. Changing either is in mutations.ts.
 */
export const webPushKeys = {
  all: ["web-push"] as const,
  key: ["web-push", "key"] as const,
  thisBrowser: ["web-push", "this-browser"] as const,
};

/**
 * OpenBot's public key, which a browser subscribes with so only this OpenBot can send to it. The
 * same in every organization and across restarts, so it is read once.
 */
export function webPushKeyQueryOptions() {
  return queryOptions({
    queryKey: webPushKeys.key,
    queryFn: async ({ signal }): Promise<string> =>
      (
        await getWebPushKey(organizationId(), {
          signal,
          fallback:
            "Couldn't turn on notifications in this browser. Try again in a moment.",
        })
      ).publicKey,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Whether this browser gets push notifications now: notifications are allowed and it holds a
 * subscription. OpenBot saves the subscription every time it starts (`keepThisBrowserSaved`), so a
 * browser that holds one is one the server sends to.
 */
export function thisBrowserQueryOptions() {
  return queryOptions({
    queryKey: webPushKeys.thisBrowser,
    queryFn: async (): Promise<{ on: boolean }> => {
      if (
        webPushSupport() !== "supported" ||
        notificationPermission() !== "granted"
      )
        return { on: false };
      const registration = await workerRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      return { on: Boolean(subscription) };
    },
  });
}
