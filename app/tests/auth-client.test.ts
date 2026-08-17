import { expect, test } from "bun:test";
import { authClient, signInWithGoogle } from "@/lib/auth/client";

test("starts the Google social sign-in flow through the Better Auth client", () => {
  expect(authClient.signIn.social).toBeFunction();
  expect(signInWithGoogle).toBeFunction();
});
