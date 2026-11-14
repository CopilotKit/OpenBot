import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { deleteSavedLogin } from "@/lib/api/generated/saved-logins/saved-logins";
import {
  cancelSignIn,
  createSignInRequest,
  finishSignIn,
  getSignInRequest,
  submitSignIn,
  submitSignInCode,
  takeOverSignIn,
  useSavedLogin,
} from "@/lib/api/generated/sign-in-requests/sign-in-requests";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { ME, passwordKeys, type SignInRequest } from "./queries";

const FALLBACK = "The sign-in could not be completed";
/** What the model is told when the server refused a sign-in request without saying why. */
const NOT_MADE = "The sign-in request could not be made.";

const invalidate = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: passwordKeys.all });

/** The request as the answer left it, shown at once rather than at the next poll. */
const show = (queryClient: QueryClient) => (request: SignInRequest) =>
  queryClient.setQueryData(passwordKeys.signIn(request.id), request);

/** What every write carries: a key of its own, and the sentence a person reads if it fails unsaid. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });
const said = { fallback: FALLBACK };

/**
 * The credential goes in the request body and nowhere else: not state, not the cache, not a log.
 *
 * No verification code: one is asked for only after the site has the password, and only if the site
 * then asks (the request is `code_required`). See `submitSignInCodeMutationOptions`.
 */
export type SignInSubmission = {
  username?: string;
  password: string;
  save?: boolean;
};

export function submitSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { id: string; input: SignInSubmission }) =>
      (
        await submitSignIn(
          ORGANIZATION_ID,
          ME,
          variables.id,
          variables.input,
          once(),
          said,
        )
      ).signInRequest,
    onSuccess: show(queryClient),
    onSettled: () => invalidate(queryClient),
  });
}

/** The verification code the site sent, once the request is `code_required`. The code and nothing else. */
export function submitSignInCodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { id: string; code: string }) =>
      (
        await submitSignInCode(
          ORGANIZATION_ID,
          ME,
          variables.id,
          { code: variables.code },
          once(),
          said,
        )
      ).signInRequest,
    onSuccess: show(queryClient),
    onSettled: () => invalidate(queryClient),
  });
}

/** Choosing a saved login in the form is the owner's confirmation to use it for this sign-in. */
export function confirmSavedLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { id: string; loginId: string }) =>
      (
        await useSavedLogin(
          ORGANIZATION_ID,
          ME,
          variables.id,
          { savedLoginId: variables.loginId },
          once(),
          said,
        )
      ).signInRequest,
    onSuccess: show(queryClient),
    onSettled: () => invalidate(queryClient),
  });
}

export function takeOverSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) =>
      (await takeOverSignIn(ORGANIZATION_ID, ME, id, once(), said))
        .signInRequest,
    onSuccess: () => invalidate(queryClient),
  });
}

export function finishSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) =>
      (await finishSignIn(ORGANIZATION_ID, ME, id, once(), said)).signInRequest,
    onSuccess: () => invalidate(queryClient),
  });
}

export function cancelSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) =>
      (await cancelSignIn(ORGANIZATION_ID, ME, id, once(), said)).signInRequest,
    onSuccess: () => invalidate(queryClient),
  });
}

export function deleteSavedLoginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (loginId: string) => {
      await deleteSavedLogin(ORGANIZATION_ID, ME, loginId, once(), {
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
  // A refusal is the answer here, in the server's own sentence, which is what the model is told.
  try {
    const { signInRequest } = await createSignInRequest(
      ORGANIZATION_ID,
      ME,
      input,
      once(),
      {
        fallback: NOT_MADE,
        ...(signal ? { signal } : {}),
      },
    );
    return { ok: true, request: signInRequest };
  } catch (error) {
    // Only the server's answer is a refusal. A request that never arrived, or one abandoned with the
    // turn, is the caller's to hear, as it always was.
    if (error instanceof ClientError)
      return { ok: false, reason: error.message };
    if (error instanceof Error && error.message === NOT_MADE)
      return { ok: false, reason: NOT_MADE };
    throw error;
  }
}

/** The request's current state, for the waiting tool call. Null when it cannot be read. */
export async function readSignIn(
  id: string,
  signal?: AbortSignal,
): Promise<SignInRequest | null> {
  try {
    return (
      await getSignInRequest(ORGANIZATION_ID, ME, id, {
        ...(signal ? { signal } : {}),
      })
    ).signInRequest;
  } catch {
    return null;
  }
}
