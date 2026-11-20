import type {
  AiConnectionLogin,
  AiConnectionProvider,
} from "@/lib/api/generated/model";
import { invokeDesktop } from "@/lib/desktop/queries";

/**
 * OpenBot Desktop's side of changing the AI connection in place (desktop_page.rs). A plan's or a
 * sign-in's credential stays with Desktop, which renews it: these commands never hand one to the
 * page, except the key an Unbiased AI sign-in mints, which goes straight on to the server.
 *
 * Each rejects with Desktop's own sentence, a string or a problem carrying `said`.
 */

/** The sentence a refused Desktop command gave, or the fallback when it gave none. */
export function desktopSentence(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const said = (error as { said?: unknown; message?: unknown }).said;
    if (typeof said === "string" && said.trim()) return said;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function desktop<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: string,
): Promise<T> {
  try {
    return await invokeDesktop<T>(command, args);
  } catch (error) {
    throw new Error(desktopSentence(error, fallback));
  }
}

export type Plan = "claude" | "chatgpt";

/** Start a Claude or ChatGPT plan sign-in. The address to approve it at, in the browser. */
export function beginPlanSignIn(plan: Plan): Promise<{ url: string }> {
  return desktop(
    "begin_plan_sign_in",
    { plan },
    "Couldn't start signing in. Try again.",
  );
}

/** Finish it: Claude with the code the browser showed, ChatGPT on its own. The token stays in Desktop. */
export function finishPlanSignIn(plan: Plan, code?: string): Promise<void> {
  return desktop(
    "finish_plan_sign_in",
    code === undefined ? { plan } : { plan, code },
    "Couldn't finish signing in. Try again.",
  );
}

export function cancelPlanSignIn(plan: Plan): Promise<void> {
  return desktop("cancel_plan_sign_in", { plan }, "Couldn't stop signing in.");
}

export type ProviderSignIn = {
  attemptId: string;
  url: string;
  userCode?: string | null;
};

/** Start a Google, xAI or Unbiased AI sign-in in the browser. */
export function beginProviderSignIn(
  provider: "google" | "xai" | "unbiased",
): Promise<ProviderSignIn> {
  return desktop(
    "begin_provider_sign_in",
    { provider },
    "Couldn't start signing in. Try again.",
  );
}

/**
 * Wait for the browser's approval. Unbiased AI's sign-in mints a key, handed back once for the page
 * to send straight to the server and drop.
 */
export function finishProviderSignIn(
  attemptId: string,
): Promise<{ apiKey?: string } | null> {
  return desktop(
    "finish_provider_sign_in",
    { attemptId },
    "Couldn't finish signing in. Try again.",
  );
}

export function cancelProviderSignIn(attemptId: string): Promise<void> {
  return desktop(
    "cancel_provider_sign_in",
    { attemptId },
    "Couldn't stop signing in.",
  );
}

/** Start the one plan engine a plan needs, and wait until it answers. Touches nothing else. */
export function prepareAiConnection(
  provider: AiConnectionProvider,
  login: AiConnectionLogin,
): Promise<{ ready: true }> {
  return desktop(
    "prepare_ai_connection",
    { provider, login },
    "OpenBot couldn't start what this plan needs. Try again.",
  );
}

/**
 * Tell Desktop the connection now in use: it records it for its next start, stops a plan engine no
 * longer needed, and moves the default Bot to one that can use it.
 */
export function settleAiConnection(connection: {
  provider: AiConnectionProvider;
  login: AiConnectionLogin;
  model?: string | null;
  endpointHost?: string | null;
}): Promise<void> {
  return desktop(
    "settle_ai_connection",
    {
      provider: connection.provider,
      login: connection.login,
      ...(connection.model ? { model: connection.model } : {}),
      ...(connection.endpointHost
        ? { endpointHost: connection.endpointHost }
        : {}),
    },
    "OpenBot Desktop couldn't finish the switch.",
  );
}
