import { useEffect } from "react";
import { toast } from "@/components/ui/toast";
import { finishRenewal, onRenewalNeedsClick } from "@/lib/auth/renewal";

const RENEWAL_TOAST = "hosted-sign-in-renewal";
const SIGN_IN_AGAIN_TOAST = "hosted-sign-in-renewal-click";

/**
 * What a hosted OpenBot's sign-in renewal says (lib/auth/renewal.ts): back from a round trip, that
 * the person is signed in again and what to do if something didn't finish; and where it couldn't
 * renew by itself, "Sign in again". Draws nothing of its own: the toasts do.
 */
export function RenewalNotices() {
  useEffect(() => {
    if (finishRenewal())
      toast.add({
        id: RENEWAL_TOAST,
        type: "info",
        title:
          "You're signed in again. If something you just did didn't finish, do it again.",
      });
    return onRenewalNeedsClick((address) => {
      // In place of "signed in again", which this answers.
      toast.close(RENEWAL_TOAST);
      toast.add({
        id: SIGN_IN_AGAIN_TOAST,
        type: "error",
        priority: "high",
        title: "Your sign-in needs renewing before you can do that.",
        actionProps: {
          children: "Sign in again",
          onClick: () => window.location.assign(address),
        },
      });
    });
  }, []);
  return null;
}
