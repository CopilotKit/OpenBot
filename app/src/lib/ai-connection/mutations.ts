import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  AiConnection,
  AiConnectionEntry,
  AiConnectionInput,
  AiConnectionProvider,
  AiSignIn,
  AiSignInInputMethod,
  AiSignInStatus,
  PersonalAiConnection,
} from "@/lib/api/generated/model";
import {
  connectAiConnection,
  connectPersonalAiConnection,
  deleteAiConnection,
  deletePersonalAiConnection,
  finishAiSignIn,
  finishPersonalAiSignIn,
  getAiConnection,
  getAiSignIn,
  getPersonalAiSignIn,
  makeAiConnectionDefault,
  makePersonalAiConnectionDefault,
  removeAiConnection,
  removePersonalAiConnection,
  replaceAiConnection,
  replacePersonalAiConnection,
  startAiSignIn,
  startPersonalAiSignIn,
} from "@/lib/api/generated/models/models";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { desktopKeys } from "@/lib/desktop/queries";
import { modelKeys } from "@/lib/models/queries";
import type { DescribedConnection } from "./describe";
import { prepareAiConnection, settleAiConnection } from "./desktop";
import { aiConnectionKeys, type ConnectionScope } from "./queries";

const FALLBACK = "Couldn't change the AI connection. Try again.";

/** Where the switch is, for the button that started it to say. */
export type ConnectPhase = "starting" | "checking" | "finishing";

export type ConnectVariables = {
  input: AiConnectionInput;
  /** In an OpenBot Desktop that changes the connection in place: it starts and settles engines. */
  desktop: boolean;
  onPhase?: (phase: ConnectPhase) => void;
};

/** What a switch ends with: the connection in use, and anything Desktop couldn't finish after it. */
export type Connected = {
  connection: DescribedConnection;
  /** Desktop's sentence when it couldn't record the switch or move the default Bot. */
  desktopProblem: string | null;
  /**
   * Whether a run with no pick now uses it, as the server answered one more connection
   * (connectAiConnection). Absent from a switch, which always makes it the one in use.
   */
  isDefault?: boolean;
};

/**
 * Switch the AI connection with no restart. The server checks it with the provider before it saves
 * anything; a refusal throws its one sentence and the connection in use keeps running.
 *
 * In Desktop the order is the contract's: a plan's engine starts first (prepare), then the server
 * switches, then Desktop settles to it. When anything before the switch fails, Desktop settles back
 * to the connection the server still reports, which stops whatever prepare started.
 */
export async function connectAi({
  input,
  desktop,
  onPhase,
}: ConnectVariables): Promise<Connected> {
  try {
    if (desktop && input.login === "plan") {
      onPhase?.("starting");
      await prepareAiConnection(input.provider, input.login);
    }
    onPhase?.("checking");
    const connection = await replaceAiConnection(
      organizationId(),
      input,
      { "Idempotency-Key": idempotencyKey() },
      { fallback: FALLBACK },
    );
    let desktopProblem: string | null = null;
    if (desktop && connection.provider && connection.login) {
      onPhase?.("finishing");
      try {
        await settleAiConnection({
          provider: connection.provider,
          login: connection.login,
          model: connection.model,
          endpointHost: connection.endpointHost,
        });
      } catch (error) {
        desktopProblem =
          error instanceof Error
            ? error.message
            : "OpenBot Desktop couldn't finish the switch.";
      }
    }
    return { connection, desktopProblem };
  } catch (error) {
    if (desktop) await settleBack();
    throw error;
  }
}

/** Desktop back on the connection the server still uses. Best effort: the refusal is the news. */
async function settleBack() {
  try {
    const current = await getAiConnection(organizationId());
    if (current.provider && current.login)
      await settleAiConnection({
        provider: current.provider,
        login: current.login,
        model: current.model,
        endpointHost: current.endpointHost,
      });
  } catch {
    // Nothing to put back, or Desktop can't say: the person reads the refusal either way.
  }
}

/**
 * The switch, for a dialog. On success the connection, the model catalogue (which provider's models
 * a person may pick) and every conversation's model choice are read again, since a pick the new
 * provider doesn't offer is now set aside.
 */
export function connectAiMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: ConnectVariables) => connectAi(variables),
    onSuccess: () => invalidateAiConnection(queryClient),
  });
}

/**
 * Every AI connection this page has read, and what follows from it. The person's own with
 * `refetchType: "all"`: the `_authed` gate reads it through `ensureQueryData`, which takes the
 * cache as it finds it, and nothing may be observing it while a person connects in onboarding.
 */
function invalidateAiConnection(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: aiConnectionKeys.personal,
      refetchType: "all",
    }),
    queryClient.invalidateQueries({ queryKey: aiConnectionKeys.all }),
    queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    queryClient.invalidateQueries({ queryKey: desktopKeys.aiConnection }),
  ]);
}

/**
 * Disconnect the organization's AI (deleteAiConnection). The server revokes the key it used and
 * keeps the others for a later switch. Everyone's runs then use their own AI where they connected
 * one (OpenBot Cloud), and nobody else's run until an admin connects another.
 */
export function disconnectAiMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<AiConnection> =>
      deleteAiConnection(
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't disconnect the AI. Try again." },
      ),
    onSuccess: () => invalidateAiConnection(queryClient),
  });
}

const PERSONAL_FALLBACK = "Couldn't connect your AI. Try again.";

/**
 * Connect the person's own AI: a key, an address, or a sign-in through OpenBot the server kept for
 * them (a plan, a provider's sign-in, or Unbiased AI's key with `useSavedKey`). The server checks it with the provider before it saves anything; a refusal
 * throws its one sentence and nothing changes. Never Desktop's engines: the server runs this
 * person's Bots, so `desktop` and its phases have nothing to do here.
 */
export function connectPersonalAiMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({ input }: ConnectVariables): Promise<Connected> => {
      const personal = await replacePersonalAiConnection(
        organizationId(),
        "me",
        input,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: PERSONAL_FALLBACK },
      );
      return { connection: personal.connection, desktopProblem: null };
    },
    onSuccess: () => invalidateAiConnection(queryClient),
  });
}

/**
 * Remove the person's own AI. Their runs use the organization's where it has one; where it has none
 * and one is required, the answer says so (`uses` none) and the app sends them to connect again.
 */
export function removePersonalAiMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<PersonalAiConnection> =>
      deletePersonalAiConnection(
        organizationId(),
        "me",
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't remove your AI. Try again." },
      ),
    onSuccess: () => invalidateAiConnection(queryClient),
  });
}

/**
 * A sign-in to an AI provider that the server runs itself, for the person's own AI. Not a cached
 * read nor a write somebody asked to keep: a step on the way to connecting, so plain functions.
 * What the provider hands back never comes to the browser. Once approved, connecting uses it: a
 * plan with `login: plan`, a Google or xAI sign-in with `login: oauth`, and Unbiased AI's key with
 * `useSavedKey`.
 *
 * `method` only for a provider with more than one way in: ChatGPT signs in in the browser unless
 * asked for `device`, its code sign-in. Left out, the server's default.
 *
 * `loopbackPort`, for Claude inside OpenBot Desktop: the port Desktop listens on for Claude's
 * redirect (sign-in-redirect.ts), so the person pastes nothing.
 */
export function startPersonalSignIn(
  provider: AiConnectionProvider,
  method?: AiSignInInputMethod,
  options?: { loopbackPort?: number },
): Promise<AiSignIn> {
  return startPersonalAiSignIn(
    organizationId(),
    "me",
    {
      provider,
      ...(method ? { method } : {}),
      ...(options?.loopbackPort !== undefined
        ? { loopbackPort: options.loopbackPort }
        : {}),
    },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't start the sign-in. Try again." },
  );
}

export function readPersonalSignIn(signInId: string): Promise<AiSignInStatus> {
  return getPersonalAiSignIn(organizationId(), "me", signInId, {
    fallback: "Couldn't check the sign-in. Try again.",
  });
}

/**
 * Finish a sign-in whose `finish` is `code`: what the person pasted, as they pasted it. For a Claude
 * plan the code Claude's page showed, for ChatGPT the address ChatGPT sent their browser to. The
 * answer says where the sign-in stands; never a key.
 */
export function finishPersonalSignIn(
  signInId: string,
  code: string,
): Promise<AiSignInStatus> {
  return finishPersonalAiSignIn(
    organizationId(),
    "me",
    signInId,
    { code },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't check the code. Try again." },
  );
}

/** The three steps of a sign-in the server runs, for one scope. */
export type SignInSteps = {
  start: (
    provider: AiConnectionProvider,
    method?: AiSignInInputMethod,
    options?: { loopbackPort?: number },
  ) => Promise<AiSignIn>;
  read: (signInId: string) => Promise<AiSignInStatus>;
  finish: (signInId: string, code: string) => Promise<AiSignInStatus>;
};

export const personalSignInSteps: SignInSteps = {
  start: startPersonalSignIn,
  read: readPersonalSignIn,
  finish: finishPersonalSignIn,
};

/**
 * The organization's sign-in (startAiSignIn), which an admin runs for everyone: what the provider
 * hands back is kept for the organization, and connected with connectAiConnection.
 */
export const organizationSignInSteps: SignInSteps = {
  start: (provider, method, options) =>
    startAiSignIn(
      organizationId(),
      {
        provider,
        ...(method ? { method } : {}),
        ...(options?.loopbackPort !== undefined
          ? { loopbackPort: options.loopbackPort }
          : {}),
      },
      { "Idempotency-Key": idempotencyKey() },
      { fallback: "Couldn't start the sign-in. Try again." },
    ),
  read: (signInId) =>
    getAiSignIn(organizationId(), signInId, {
      fallback: "Couldn't check the sign-in. Try again.",
    }),
  finish: (signInId, code) =>
    finishAiSignIn(
      organizationId(),
      signInId,
      { code },
      { "Idempotency-Key": idempotencyKey() },
      { fallback: "Couldn't check the code. Try again." },
    ),
};

export function signInStepsFor(scope: ConnectionScope): SignInSteps {
  return scope === "organization"
    ? organizationSignInSteps
    : personalSignInSteps;
}

/*
 * Several AI connections at once: connect one more, make one the default, remove one. Each reads
 * every AI connection again afterwards, with the models and every conversation's choice, since
 * which models a person may pick follows from them.
 */

/** Connect one more AI connection beside the others (connectAiConnection). */
export function addAiConnectionMutationOptions(
  queryClient: QueryClient,
  scope: ConnectionScope,
) {
  return mutationOptions({
    mutationFn: async ({ input }: ConnectVariables): Promise<Connected> => {
      const connection =
        scope === "organization"
          ? await connectAiConnection(
              organizationId(),
              input,
              { "Idempotency-Key": idempotencyKey() },
              { fallback: FALLBACK },
            )
          : await connectPersonalAiConnection(
              organizationId(),
              "me",
              input,
              { "Idempotency-Key": idempotencyKey() },
              { fallback: PERSONAL_FALLBACK },
            );
      return {
        connection,
        desktopProblem: null,
        isDefault: connection.isDefault,
      };
    },
    onSuccess: () => invalidateAiConnection(queryClient),
  });
}

export type MakeDefaultVariables = {
  entry: AiConnectionEntry;
  /** In an OpenBot Desktop that changes the connection in place: a plan's engine starts first. */
  desktop: boolean;
};

/**
 * Make one connection the default. In Desktop the order is connectAi's: a plan's engine starts
 * first, then the server, then Desktop settles to it; anything failing before settles back.
 */
async function makeDefault(
  scope: ConnectionScope,
  { entry, desktop }: MakeDefaultVariables,
): Promise<AiConnectionEntry> {
  const fallback = "Couldn't make it the default. Try again.";
  if (scope === "personal")
    return makePersonalAiConnectionDefault(
      organizationId(),
      "me",
      entry.id,
      { "Idempotency-Key": idempotencyKey() },
      { fallback },
    );
  try {
    if (desktop && entry.login === "plan")
      await prepareAiConnection(entry.provider, entry.login);
    const made = await makeAiConnectionDefault(
      organizationId(),
      entry.id,
      { "Idempotency-Key": idempotencyKey() },
      { fallback },
    );
    if (desktop)
      await settleAiConnection({
        provider: made.provider,
        login: made.login,
        model: made.model,
        endpointHost: made.endpointHost,
      }).catch(() => {});
    return made;
  } catch (error) {
    if (desktop) await settleBack();
    throw error;
  }
}

export function makeDefaultAiConnectionMutationOptions(
  queryClient: QueryClient,
  scope: ConnectionScope,
) {
  return mutationOptions({
    mutationFn: (variables: MakeDefaultVariables) =>
      makeDefault(scope, variables),
    onSuccess: () => invalidateAiConnection(queryClient),
  });
}

export type RemoveVariables = {
  id: string;
  /** The connection that takes over as the default, made default before the remove. */
  nextDefault?: AiConnectionEntry;
  desktop?: boolean;
};

/**
 * Remove one connection. The server never moves the default by itself, so when another takes over
 * it is made the default first, and only then is this one removed.
 */
export function removeAiConnectionMutationOptions(
  queryClient: QueryClient,
  scope: ConnectionScope,
) {
  return mutationOptions({
    mutationFn: async ({
      id,
      nextDefault,
      desktop = false,
    }: RemoveVariables): Promise<void> => {
      if (nextDefault)
        await makeDefault(scope, { entry: nextDefault, desktop });
      const fallback = "Couldn't disconnect it. Try again.";
      if (scope === "organization")
        await removeAiConnection(
          organizationId(),
          id,
          { "Idempotency-Key": idempotencyKey() },
          { fallback },
        );
      else
        await removePersonalAiConnection(
          organizationId(),
          "me",
          id,
          { "Idempotency-Key": idempotencyKey() },
          { fallback },
        );
    },
    onSettled: () => invalidateAiConnection(queryClient),
  });
}
