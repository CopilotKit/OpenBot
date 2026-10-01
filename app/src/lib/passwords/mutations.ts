import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { passwordKeys, type SignInRequest } from "./queries";

const FALLBACK = "The sign-in could not be completed";

const invalidate = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: passwordKeys.all });

const path = (id: string, action: string) =>
  `/api/sign-in-requests/${encodeURIComponent(id)}/${action}`;

async function post(id: string, action: string, body?: unknown) {
  return (await client(path(id, action), {
    method: "POST",
    ...(body === undefined ? {} : { body }),
    fallback: FALLBACK,
  }).then((response) => response.json())) as SignInRequest;
}

/** The credential goes in the request body and nowhere else: not state, not the cache, not a log. */
export type SignInSubmission = {
  username?: string;
  password: string;
  code?: string;
  save?: boolean;
};

export function submitSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; input: SignInSubmission }) =>
      post(variables.id, "submit", variables.input),
    onSettled: () => invalidate(queryClient),
  });
}

/** Choosing a saved login in the form is the owner's confirmation to use it for this sign-in. */
export function confirmSavedLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; loginId: string; code?: string }) =>
      post(variables.id, "use-saved", {
        loginId: variables.loginId,
        ...(variables.code ? { code: variables.code } : {}),
      }),
    onSettled: () => invalidate(queryClient),
  });
}

export function takeOverSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) => post(id, "take-over"),
    onSuccess: () => invalidate(queryClient),
  });
}

export function finishSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) => post(id, "finish"),
    onSuccess: () => invalidate(queryClient),
  });
}

export function cancelSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string) => post(id, "cancel"),
    onSuccess: () => invalidate(queryClient),
  });
}

export function deleteSavedLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (loginId: string) => {
      await client(`/api/passwords/${encodeURIComponent(loginId)}`, {
        method: "DELETE",
        fallback: "Could not delete that password",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

/**
 * A Bot's turn asking to be signed in, from the open chat. A tool call rather than a cached write,
 * so a plain function: it fails closed and returns the answer.
 */
export async function requestSignIn(
  input: { botId: string; site: string; reason?: string; toolCallId?: string },
  signal?: AbortSignal,
): Promise<
  { ok: true; request: SignInRequest } | { ok: false; reason: string }
> {
  const response = await tryClient("/api/sign-in-requests", {
    method: "POST",
    body: input,
    ...(signal ? { signal } : {}),
  });
  const body = (await response.json().catch(() => null)) as
    | (SignInRequest & { error?: string })
    | null;
  if (!response.ok || !body)
    return {
      ok: false,
      reason: body?.error ?? "The sign-in request could not be made.",
    };
  return { ok: true, request: body };
}

/** The request's current state, for the waiting tool call. Null when it cannot be read. */
export async function readSignIn(id: string, signal?: AbortSignal) {
  const response = await tryClient(
    `/api/sign-in-requests/${encodeURIComponent(id)}`,
    {
      ...(signal ? { signal } : {}),
    },
  ).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as SignInRequest | null;
}
