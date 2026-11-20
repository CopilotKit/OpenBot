import { useEffect } from "react";
import { toast } from "@/components/ui/toast";
import {
  finishRenewal,
  onRenewalNeedsClick,
  takePendingWrite,
} from "@/lib/auth/renewal";
import { replayPendingWrite } from "@/lib/auth/renewal-replay";
import { queryClient } from "@/query-client";

const RENEWAL_TOAST = "hosted-sign-in-renewal";
const SIGN_IN_AGAIN_TOAST = "hosted-sign-in-renewal-click";

/**
 * What a hosted OpenBot's sign-in renewal does on the page (lib/auth/renewal.ts). Back from a round
 * trip, the write the renewal interrupted is sent again, once, with its own Idempotency-Key, and the
 * page says how it went; where it couldn't renew by itself, it offers "Sign in again". Draws nothing
 * of its own: the toasts do.
 */
export function RenewalNotices() {
  useEffect(() => {
    if (finishRenewal()) {
      const write = takePendingWrite();
      if (!write)
        toast.add({
          id: RENEWAL_TOAST,
          type: "info",
          title: "You're signed in again.",
        });
      else
        void replayPendingWrite(write, queryClient).then((outcome) =>
          toast.add(
            outcome.done
              ? {
                  id: RENEWAL_TOAST,
                  type: "success",
                  title: "You're signed in again, and that's done.",
                }
              : {
                  id: RENEWAL_TOAST,
                  type: "error",
                  title: outcome.said,
                },
          ),
        );
    }
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
