import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { updatePerson } from "@/lib/api/generated/people/people";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  desktopConnectionQueryOptions,
  invokeDesktop,
} from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { forgetThisBrowser } from "@/lib/web-push/mutations";
import { clearSkin } from "@/skins/store";
import { authClient } from "./client";
import { hostedSignOutAddress } from "./hosted";
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

/**
 * Whether this is a hosted OpenBot (`hostedSignIn`), asked before the sign-out while the answer is still the
 * signed-in person's to read. Not known reads as not hosted: the sign-out here still happens.
 */
async function hostedHere(queryClient: QueryClient): Promise<boolean> {
  try {
    const capabilities = await queryClient.ensureQueryData(
      deploymentCapabilitiesQueryOptions(),
    );
    return capabilities.hostedSignIn === true;
  } catch {
    return false;
  }
}

/**
 * How a sign-out ended: `leaving` when the window is going somewhere else to finish it, the desktop app taking it
 * back to its setup, or a hosted OpenBot's own sign-out.
 */
export type SignedOut = { leaving: boolean };

/**
 * Every way out of OpenBot signs out through here, the skins' own menus included.
 *
 * Push notifications in this browser end with the sign-out (`forgetThisBrowser`), so the next
 * person to sign in here is not sent the last one's.
 *
 * The skin is the account's, and this browser only caches it to paint before the preferences load.
 * Clearing it here means the next person on a shared machine starts from the default rather than
 * from the last person's skin.
 *
 * On a hosted OpenBot the person is also signed in to OpenBot by CopilotKit in this browser, and that sign-in is
 * what "Continue with OpenBot by CopilotKit" uses. So once OpenBot has signed them out, the browser goes through
 * the hosted sign-out, which ends that sign-in too and comes back to the sign-in screen: the next person to sign in
 * here chooses their own account rather than being signed in as the last one.
 */
export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<SignedOut> => {
      if (await connectedThroughDesktop(queryClient)) {
        await signOutThroughDesktop();
        return { leaving: true };
      }
      const hosted = await hostedHere(queryClient);
      // While still signed in, so the server can be told. Never holds the sign-out up for long.
      await forgetThisBrowser();
      await signOut();
      if (!hosted) return { leaving: false };
      window.location.assign(
        hostedSignOutAddress(`${window.location.origin}/sign`),
      );
      return { leaving: true };
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
