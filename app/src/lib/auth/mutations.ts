import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "Could not sign out",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => queryClient.removeQueries({ queryKey: authKeys.all }),
  });
}

export function updateCurrentUserAvatarMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (image: string | null) =>
      client<{ image: string | null; hasCustomAvatar: boolean }>(
        "/api/me/avatar",
        "avatar",
        {
          method: "PUT",
          body: { image },
          fallback: "Could not save your avatar",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: authKeys.currentUser() }),
  });
}
