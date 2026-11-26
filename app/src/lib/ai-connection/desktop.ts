import type {
  AiConnectionLogin,
  AiConnectionProvider,
  AiConnectionProviderAnswer,
} from "@/lib/api/generated/model";
import { invokeDesktop } from "@/lib/desktop/queries";

/**
 * OpenBot Desktop's side of changing the AI connection in place (desktop_page.rs). A plan's or a
 * sign-in's credential stays with Desktop, which renews it: these commands never hand one to the
 * page.
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

/**
 * Start a Claude or ChatGPT plan sign-in. The address to approve it at, in the browser.
 *
 * Claude's asks for the loopback redirect: the browser comes back to Desktop, and the sign-in
 * finishes on its own. A Desktop older than that ignores the ask and answers Claude's code page
 * instead, which `finishesInDesktop` tells apart.
 */
export function beginPlanSignIn(plan: Plan): Promise<{ url: string }> {
  return desktop(
    "begin_plan_sign_in",
    plan === "claude" ? { plan, redirect: "loopback" } : { plan },
    "Couldn't start signing in. Try again.",
  );
}

/**
 * Whether a Claude plan sign-in Desktop started finishes on its own: its address sends the browser
 * back to this computer (`redirect_uri` on localhost). Otherwise it is Claude's code page, from a
 * Desktop older than the loopback sign-in, and the person pastes the code it shows.
 */
export function finishesInDesktop(url: string): boolean {
  let redirect: string | null;
  try {
    redirect = new URL(url).searchParams.get("redirect_uri");
  } catch {
    return false;
  }
  if (!redirect) return false;
  try {
    const back = new URL(redirect);
    return (
      back.protocol === "http:" &&
      (back.hostname === "localhost" || back.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

/**
 * Finish it: on its own, once the browser comes back to Desktop, or for Claude from an older
 * Desktop with the code the browser showed. The token stays in Desktop.
 */
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

/** Start an xAI sign-in in the browser. */
export function beginProviderSignIn(): Promise<ProviderSignIn> {
  return desktop(
    "begin_provider_sign_in",
    { provider: "xai" },
    "Couldn't start signing in. Try again.",
  );
}

/** Wait for the browser's approval. */
export function finishProviderSignIn(attemptId: string): Promise<void> {
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
  /** As the server answered it, so possibly a provider this app doesn't know: Desktop says so. */
  provider: AiConnectionProviderAnswer;
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
