import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { authKeys } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    // What a refused sign-out means whoever answers it (Better Auth puts its sentence where `client` does not read).
    fallback: "Signing out did not finish. Try again.",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => queryClient.removeQueries({ queryKey: authKeys.all }),
  });
}
