import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * A Bot's request to be signed in to a website, as the private form sees it.
 *
 * Never carries a credential: the form sends one and the server passes it to the Bot's computer.
 * `savedLogins` lists usernames only, and only while the workspace's password manager is on.
 */
export type SignInStatus =
  | "pending"
  | "filling"
  | "taken_over"
  | "signed_in"
  | "failed"
  | "cancelled"
  | "expired";

export type SignInRequest = {
  id: string;
  botId: string;
  origin: string;
  reason: string | null;
  status: SignInStatus;
  method: "typed" | "saved" | "takeover" | null;
  /** The last thing that happened, e.g. why a submitted login did not work. */
  outcome: string | null;
  controlRequestId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  passwordManager: boolean;
  savedLogins: { id: string; username: string }[];
};

export type SavedLogin = {
  id: string;
  origin: string;
  username: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export const passwordKeys = {
  all: ["passwords"] as const,
  logins: () => ["passwords", "logins"] as const,
  signIn: (id: string) => ["passwords", "sign-in", id] as const,
};

export const FINAL_SIGN_IN: readonly SignInStatus[] = [
  "signed_in",
  "failed",
  "cancelled",
  "expired",
];

export function signInRequestQueryOptions(id: string) {
  return queryOptions({
    queryKey: passwordKeys.signIn(id),
    queryFn: async (): Promise<SignInRequest> =>
      (
        await client(`/api/sign-in-requests/${encodeURIComponent(id)}`, {
          fallback: "Could not load this sign-in request",
        })
      ).json(),
  });
}

export function savedLoginsQueryOptions() {
  return queryOptions({
    queryKey: passwordKeys.logins(),
    queryFn: async (): Promise<{
      passwordManager: boolean;
      logins: SavedLogin[];
    }> =>
      (
        await client("/api/passwords", {
          fallback: "Could not load your passwords",
        })
      ).json(),
  });
}
