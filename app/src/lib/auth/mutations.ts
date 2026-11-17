import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { updatePerson } from "@/lib/api/generated/people/people";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import {
  desktopConnectionQueryOptions,
  invokeDesktop,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { clearSkin } from "@/skins/store";
import { authClient } from "./client";
import { authKeys } from "./queries";

const SIGN_OUT_UNFINISHED = "Signing out did not finish. Try again.";

/**
 * Sign out through Better Auth's own client, which owns sign-in's addresses. It answers a refusal
 * rather than throwing, so a refused sign-out is thrown here, in one plain sentence whoever refused
 * it (Better Auth, or the organization's sign-in) and whatever kept it from reaching the server.
 */
async function signOut() {
  const answered = await authClient.signOut().catch(() => null);
  if (!answered || answered.error) throw new Error(SIGN_OUT_UNFINISHED);
}

/**
 * Whether this page is inside an OpenBot Desktop connected to an OpenBot that runs somewhere else.
 * There the desktop app holds the sign-in and the page holds none, so the desktop app is what signs
 * out, and it shows its own setup afterwards.
 */
export async function connectedThroughDesktop(
  queryClient: QueryClient,
): Promise<boolean> {
  if (desktopShell() === null) return false;
  const connection = await queryClient.ensureQueryData(
    desktopConnectionQueryOptions(),
  );
  return connection.mode === "connected";
}

/** Ask the desktop app to sign out of the OpenBot it is connected to. */
export async function signOutThroughDesktop() {
  try {
    await invokeDesktop("sign_out");
  } catch {
    throw new Error(SIGN_OUT_UNFINISHED);
  }
}

/** How a sign-out ended: `leaving` when the desktop app is taking the window back to its setup. */
export type SignedOut = { leaving: boolean };

/**
 * Every way out of OpenBot signs out through here, the skins' own menus included.
 *
 * The skin is the account's, and this browser only caches it to paint before the preferences load.
 * Clearing it here means the next person on a shared machine starts from the default rather than
 * from the last person's skin.
 */
export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<SignedOut> => {
      if (await connectedThroughDesktop(queryClient)) {
        await signOutThroughDesktop();
        return { leaving: true };
      }
      await signOut();
      return { leaving: false };
    },
    onSuccess: () => {
      clearSkin();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}

/** Saves the person's display name, then refreshes who they are. */
export function updateProfileNameMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (name: string) =>
      updatePerson(
        organizationId(),
        "me",
        { name },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Your name could not be saved" },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: authKeys.currentUser(),
        refetchType: "all",
      }),
  });
}
