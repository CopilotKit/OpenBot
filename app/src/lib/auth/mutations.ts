import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearSkin } from "@/skins/store";
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    // What a refused sign-out means whoever answers it (Better Auth puts its sentence where `client` does not read).
    fallback: "Signing out did not finish. Try again.",
  });
}

/**
 * Every way out of OpenBot signs out through here, the skins' own menus included.
 *
 * The skin is the account's, and this browser only caches it to paint before the preferences load.
 * Clearing it here means the next person on a shared machine starts from the default rather than
 * from the last person's skin.
 */
export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
      clearSkin();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}
