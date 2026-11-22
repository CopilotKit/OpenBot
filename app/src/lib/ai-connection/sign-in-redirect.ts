import { desktopSentence } from "@/lib/ai-connection/desktop";
import type {
  AiConnectionLogin,
  AiConnectionProvider,
  AiSignIn,
  AiSignInInputMethod,
  AiSignInStatus,
} from "@/lib/api/generated/model";
import { ClientError } from "@/lib/client";
import { invokeDesktop } from "@/lib/desktop/queries";

/**
 * A Claude or ChatGPT plan sign-in the server runs, finished inside OpenBot Desktop with nothing to
 * paste. Desktop listens on the person's own computer for the provider's redirect, as other apps
 * that sign in to these plans do, and hands the page what arrives. The page sends it on to the
 * server (finishPersonalAiSignIn), which keeps the sign-in exactly as it keeps a pasted one.
 *
 * - Claude: Desktop listens on a port it picks, at /callback. The server is told the port
 *   (`loopbackPort`) and sends Claude's redirect there. What arrives goes on as `code#state`,
 *   the shape Claude's own page shows.
 * - ChatGPT: its browser sign-in always redirects to localhost:1455/auth/callback, where Desktop
 *   listens. What arrives goes on as that whole address, as a person would paste it.
 *
 * Anything that stops this way (an OpenBot Desktop from before it could listen, a busy port, a
 * server from before it took the port, a redirect that isn't Desktop's) falls back to what the
 * person gets today, never a dead end: Claude's paste, ChatGPT's code sign-in (`fallbackMethod`).
 */

export type RedirectProvider = "anthropic" | "openai";

/** Desktop listening for one sign-in's redirect. */
export type RedirectListening = { attemptId: string; port: number };

/** What the provider's redirect brought to Desktop: a code, or the error the provider sent. */
export type RedirectArrival = {
  code: string | null;
  state: string;
  error: string | null;
};

/** Where ChatGPT's browser sign-in sends the browser: fixed by OpenAI for its client. */
export const CHATGPT_REDIRECT = "http://localhost:1455/auth/callback";

const CLAUDE_NOT_APPROVED =
  "The Claude sign-in wasn't approved. Sign in again.";
const DIDNT_FINISH = "The sign-in didn't finish. Try again.";

/** Start listening for the provider's redirect. Rejects with Desktop's sentence when it can't. */
export async function beginSignInRedirect(
  provider: RedirectProvider,
): Promise<RedirectListening> {
  let answer: unknown;
  try {
    answer = await invokeDesktop<unknown>("begin_sign_in_redirect", {
      provider,
    });
  } catch (error) {
    throw new Error(
      desktopSentence(error, "OpenBot Desktop couldn't wait for the sign-in."),
    );
  }
  const listening = answer as Partial<RedirectListening> | null;
  if (
    typeof listening?.attemptId !== "string" ||
    !listening.attemptId ||
    typeof listening.port !== "number" ||
    !Number.isInteger(listening.port)
  )
    throw new Error("OpenBot Desktop couldn't wait for the sign-in.");
  return { attemptId: listening.attemptId, port: listening.port };
}

/** Wait (up to 15 minutes) for the redirect carrying `state`. */
export async function awaitSignInRedirect(
  attemptId: string,
  state: string,
): Promise<RedirectArrival> {
  try {
    return await invokeDesktop<RedirectArrival>("await_sign_in_redirect", {
      attemptId,
      state,
    });
  } catch (error) {
    throw new Error(desktopSentence(error, DIDNT_FINISH));
  }
}

/** Stop listening. Never fails a caller: a listener already gone is what was asked for. */
export function cancelSignInRedirect(attemptId: string): void {
  void invokeDesktop("cancel_sign_in_redirect", { attemptId }).catch(() => {});
}

/**
 * Whether this sign-in can finish through Desktop's listener: inside OpenBot Desktop, a sign-in the
 * server runs, a Claude plan, or a ChatGPT plan's browser sign-in (its code sign-in needs nothing
 * pasted already). `pasteBack`: this provider already fell back to the paste here.
 */
export function takesRedirect({
  inDesktop,
  serverRun,
  provider,
  login,
  method,
  pasteBack,
}: {
  inDesktop: boolean;
  serverRun: boolean;
  provider: AiConnectionProvider | undefined;
  login: AiConnectionLogin | null;
  method: AiSignInInputMethod | undefined;
  pasteBack: boolean;
}): boolean {
  if (!inDesktop || !serverRun || pasteBack || login !== "plan") return false;
  if (provider === "anthropic") return true;
  return provider === "openai" && method !== "device";
}

/**
 * How a sign-in Desktop can't take starts instead: what that person gets today. Claude's code to
 * paste (its only way), and for ChatGPT its code sign-in (`device`), the first way outside Desktop,
 * never the address paste first.
 */
export function fallbackMethod(
  provider: RedirectProvider,
): AiSignInInputMethod | undefined {
  return provider === "openai" ? "device" : undefined;
}

/** The redirect Desktop listens at for this provider. */
export function redirectFor(provider: RedirectProvider, port: number): string {
  return provider === "anthropic"
    ? `http://localhost:${port}/callback`
    : CHATGPT_REDIRECT;
}

/**
 * The state of a sign-in whose provider page sends the browser to Desktop's listener, read from
 * that page's address. Null when the page sends it anywhere else (a server that didn't take the
 * port), or carries no state to wait for.
 */
export function loopbackState(
  url: string,
  provider: RedirectProvider,
  port: number,
): string | null {
  let page: URL;
  let redirect: URL;
  try {
    page = new URL(url);
    redirect = new URL(page.searchParams.get("redirect_uri") ?? "");
  } catch {
    return null;
  }
  const expected = new URL(redirectFor(provider, port));
  const loopback =
    redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1";
  if (
    redirect.protocol !== "http:" ||
    !loopback ||
    redirect.port !== expected.port ||
    redirect.pathname !== expected.pathname
  )
    return null;
  return page.searchParams.get("state")?.trim() || null;
}

/**
 * What to send the server to finish, from what arrived: Claude's `code#state`, or ChatGPT's whole
 * address. ChatGPT's error goes on too, so the server ends the sign-in in its own words. Claude's
 * ends here: there is no code to send.
 */
export function finishingText(
  provider: RedirectProvider,
  arrival: RedirectArrival,
): { send: string } | { failed: string } {
  const code = arrival.code?.trim() || null;
  if (provider === "anthropic") {
    if (arrival.error) return { failed: CLAUDE_NOT_APPROVED };
    if (!code) return { failed: DIDNT_FINISH };
    return { send: `${code}#${arrival.state}` };
  }
  const query = new URLSearchParams();
  if (code) query.set("code", code);
  else if (arrival.error) query.set("error", arrival.error);
  else return { failed: DIDNT_FINISH };
  query.set("state", arrival.state);
  return { send: `${CHATGPT_REDIRECT}?${query.toString()}` };
}

/** The calls a sign-in through Desktop makes, each the real one in the app. */
export type RedirectSteps = {
  begin: (provider: RedirectProvider) => Promise<RedirectListening>;
  /** Start the server's sign-in, telling it Desktop's port where the provider takes one. */
  start: (loopbackPort: number | undefined) => Promise<AiSignIn>;
  wait: (attemptId: string, state: string) => Promise<RedirectArrival>;
  cancel: (attemptId: string) => void;
  finish: (signInId: string, code: string) => Promise<AiSignInStatus>;
  /** Desktop is listening for `attemptId`, or no longer (null): what stopping the sign-in cancels. */
  hold: (attemptId: string | null) => void;
  /** The sign-in is under way: show it waiting, and open the provider's page. */
  opened: (signIn: AiSignIn) => void;
  /** Still the sign-in the person is looking at. */
  current: () => boolean;
};

export type RedirectOutcome =
  | { outcome: "approved" }
  /** The person stopped it, or started another. */
  | { outcome: "stopped" }
  /** Finish it by paste instead, with the sign-in already started when there is one. */
  | { outcome: "paste"; begun: AiSignIn | null };

/**
 * Sign in through Desktop's listener, end to end. Rejects with the sentence to show when the
 * sign-in itself fails: the provider said no, or the server refused what arrived.
 */
export async function signInThroughDesktop(
  provider: RedirectProvider,
  steps: RedirectSteps,
): Promise<RedirectOutcome> {
  let listening: RedirectListening;
  try {
    listening = await steps.begin(provider);
  } catch {
    // An OpenBot Desktop from before it could listen, or a port it can't have.
    return steps.current()
      ? { outcome: "paste", begun: null }
      : { outcome: "stopped" };
  }
  if (!steps.current()) {
    steps.cancel(listening.attemptId);
    return { outcome: "stopped" };
  }
  steps.hold(listening.attemptId);
  const release = () => {
    steps.hold(null);
    steps.cancel(listening.attemptId);
  };

  let begun: AiSignIn;
  try {
    begun = await steps.start(
      provider === "anthropic" ? listening.port : undefined,
    );
  } catch (error) {
    if (!steps.current()) return { outcome: "stopped" };
    release();
    // A server from before it took the port refuses the field it doesn't know: the paste, without it.
    if (
      provider === "anthropic" &&
      error instanceof ClientError &&
      error.status === 400
    )
      return { outcome: "paste", begun: null };
    throw error;
  }
  if (!steps.current()) return { outcome: "stopped" };

  const state = loopbackState(begun.url, provider, listening.port);
  if (!state) {
    // The provider's page sends the browser somewhere Desktop isn't listening: paste this one back.
    release();
    return { outcome: "paste", begun };
  }

  steps.opened(begun);
  let arrival: RedirectArrival;
  try {
    arrival = await steps.wait(listening.attemptId, state);
  } catch (error) {
    if (!steps.current()) return { outcome: "stopped" };
    // Fifteen minutes with no redirect, or Desktop gave up waiting: make sure it stops listening.
    release();
    throw error;
  }
  if (!steps.current()) return { outcome: "stopped" };
  steps.hold(null);

  const text = finishingText(provider, arrival);
  if ("failed" in text) throw new Error(text.failed);
  const status = await steps.finish(begun.id, text.send);
  if (!steps.current()) return { outcome: "stopped" };
  if (status.status !== "approved")
    throw new Error(status.detail ?? DIDNT_FINISH);
  return { outcome: "approved" };
}
