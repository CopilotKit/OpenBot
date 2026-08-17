import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export async function signInWithGoogle() {
  const result = await authClient.signIn.social({
    provider: "google" as never,
    callbackURL: window.location.origin,
  });

  if (result.error) {
    throw new Error(result.error.message ?? "Could not start Google sign-in.");
  }
}
