import { useMutation, useQuery } from "@tanstack/react-query";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notifications/permission";
import { webPushSupport } from "@/lib/web-push/browser";
import { turnOnWebPushMutationOptions } from "@/lib/web-push/mutations";
import { thisBrowserQueryOptions } from "@/lib/web-push/queries";
import { queryClient } from "@/query-client";

/**
 * What a place that offers to turn notifications on shows:
 *
 * - `button`: a button that turns them on.
 * - `home-screen-first` / `newer-ios-first`: an iPhone or iPad, where no button can work yet, so the
 *   sentence that says what to do first (web-push-words.ts) instead.
 * - `null`: nothing, because they are on, the browser blocks them, or it can't show any.
 */
export type NotificationsOffer =
  | "button"
  | "home-screen-first"
  | "newer-ios-first"
  | null;

/**
 * ONE PRESS, WHEREVER IT IS MADE. The offer in a conversation, a Bot's page and Settings all end in
 * the same state: in a browser with the Push API, notifications allowed AND this browser's push
 * subscription saved, so a Bot's reply, question or approval reaches it with OpenBot closed
 * (`turnOnWebPushMutationOptions`, the mutation Settings' switch runs). Where there is no Push API
 * (OpenBot Desktop, whose app shows them, or an OpenBot opened at a plain-HTTP address), the
 * browser's permission alone, for the notices a page raises while it is open.
 *
 * The browser's permission prompt is asked inside `turnOn` itself, which the caller runs in the
 * press: Safari shows it only from a person's tap.
 */
export function useNotificationsOffer() {
  const support = webPushSupport();
  const permission = useNotificationPermission();
  const browser = useQuery(
    { ...thisBrowserQueryOptions(), enabled: support === "supported" },
    queryClient,
  );
  const subscribe = useMutation(
    turnOnWebPushMutationOptions(queryClient),
    queryClient,
  );

  const offer: NotificationsOffer =
    support === "home-screen-first" || support === "newer-ios-first"
      ? support
      : support === "supported"
        ? permission !== "denied" && browser.data?.on === false
          ? "button"
          : null
        : permission === "default"
          ? "button"
          : null;

  /** Turns them on. `done` runs once it is over, whatever the answer. */
  function turnOn(done?: (outcome: { failed: Error | null }) => void) {
    const asked = requestNotificationPermission();
    if (support !== "supported") {
      void asked.then(() => done?.({ failed: null }));
      return;
    }
    subscribe.mutate(asked, {
      onSuccess: () => done?.({ failed: null }),
      onError: (error) => done?.({ failed: error }),
    });
  }

  return {
    offer,
    turnOn,
    pending: subscribe.isPending,
    error: subscribe.error,
  };
}
