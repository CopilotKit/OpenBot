import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@/components/ui/toast";
import { signOutMutationOptions } from "@/lib/auth/mutations";

/** The one toast a sign-out that did not finish says itself in. */
const SIGN_OUT_TOAST = "sign-out-unfinished";

/**
 * Sign out, then go to the sign-in screen. A sign-out the server could not finish (it ends the person's Recorders
 * first, and does not sign out when it cannot) leaves the person signed in and where they were, told so in a toast that
 * stays until they close it; Sign out works again at once.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  return {
    pending: signOut.isPending,
    run: () => {
      if (signOut.isPending) return;
      signOut.mutate(undefined, {
        onSuccess: () => {
          toast.close(SIGN_OUT_TOAST);
          void navigate({ to: "/sign" });
        },
        onError: (error) =>
          toast.add({
            // One at a time: a second refusal replaces the first rather than stacking under it.
            id: SIGN_OUT_TOAST,
            title: error.message,
            type: "error",
            priority: "high",
          }),
      });
    },
  };
}
