import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { DeleteAccountDialog } from "@/components/settings/delete-account";
import { Button } from "@/components/ui/button";
import { cancelAccountDeletionMutationOptions } from "@/lib/account-deletion/mutations";
import {
  deletionResumed,
  deletionToResume,
  onPendingDeletionChange,
  type PendingDeletion,
  pendingDeletion,
  pendingPageDeps,
} from "@/lib/account-deletion/pending";
import {
  accountDeletionQueryOptions,
  deletionDay,
} from "@/lib/account-deletion/queries";
import { ClientError } from "@/lib/client";
import { failureSaid } from "@/lib/load-failure";
import { queryClient } from "@/query-client";

/** How the page loads the app afresh (lib/account-deletion/pending.ts). A test replaces it. */
export { pendingPageDeps };

/**
 * What somebody whose account is scheduled to be deleted sees, in place of every screen: when it
 * goes, and what they can do. Cancel deletion gives the account back and opens the app afresh, so
 * nothing the refusals left behind is drawn. Delete now deletes it without waiting out the days
 * left, with the same confirmation as Settings (their address, the phrase, a recent sign-in: Sign
 * in again comes back here, with the dialog open). Sign out is always there.
 *
 * In the sign-in screen's own layout, as the page for an organization that holds the person out is.
 */
export function PendingDeletionPage({
  deletion,
}: {
  deletion?: PendingDeletion;
}) {
  const signOut = useSignOut();
  const [deleting, setDeleting] = useState(false);
  // Back from signing in again to delete now: the dialog opens where they left it, once.
  useEffect(() => {
    if (!deletionToResume()) return;
    deletionResumed();
    setDeleting(true);
  }, []);
  const read = useQuery(accountDeletionQueryOptions());
  const deleteAfter =
    deletion?.deleteAfter ??
    (read.data?.status === "scheduled" ? read.data.deleteAfter : undefined);
  const day = deleteAfter ? deletionDay(deleteAfter) : undefined;
  const cancel = useMutation({
    ...cancelAccountDeletionMutationOptions(queryClient),
    onSuccess: () => pendingPageDeps.openHome(),
    onError: (error) => {
      // This sign-in ended with the request: signing in again comes back here, where cancelling works.
      if (error instanceof ClientError && error.status === 401)
        pendingPageDeps.openSignIn();
    },
  });
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center">
      <div className="flex w-full max-w-82 flex-col items-center p-4">
        <AgentOrb size="56px" />
        <h1 className="mt-8 text-balance text-center font-medium text-2xl tracking-tight">
          {day
            ? `Your account will be deleted on ${day}.`
            : "Your account will be deleted."}
        </h1>
        <div className="mt-8 flex w-full flex-col gap-2">
          <Button
            className="h-10 w-full tracking-tight"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            size="lg"
          >
            {cancel.isPending ? "Cancelling…" : "Cancel deletion"}
          </Button>
          <Button
            className="h-10 w-full tracking-tight"
            disabled={cancel.isPending}
            onClick={() => setDeleting(true)}
            size="lg"
            variant="destructive"
          >
            Delete now
          </Button>
          <Button
            className="h-10 w-full tracking-tight"
            disabled={signOut.pending}
            onClick={signOut.run}
            size="lg"
            variant="ghost"
          >
            {signOut.pending ? "Signing out…" : "Sign out"}
          </Button>
          {cancel.error ? (
            <p
              className="mt-1 text-center text-destructive text-sm"
              role="alert"
            >
              {failureSaid(cancel.error)}
            </p>
          ) : null}
        </div>
      </div>
      <DeleteAccountDialog now onOpenChange={setDeleting} open={deleting} />
    </div>
  );
}

/**
 * The signed-in app, until the person's account is found to be scheduled for deletion while it is
 * open (lib/account-deletion/pending.ts): from then, the pending page in place of every screen.
 */
export function PendingDeletionGate({ children }: { children: ReactNode }) {
  const deletion = useSyncExternalStore(
    onPendingDeletionChange,
    pendingDeletion,
    pendingDeletion,
  );
  return deletion === undefined ? (
    children
  ) : (
    <PendingDeletionPage deletion={deletion} />
  );
}
