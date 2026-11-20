/**
 * Renewing a hosted OpenBot's sign-in without asking the person anything.
 *
 * On a hosted OpenBot an admin's actions carry a proof from OpenBot by CopilotKit that lasts an
 * hour. When it has run out, OpenBot refuses the action with 401 and the code
 * `HOSTED_SIGN_IN_RENEWAL_REQUIRED`, naming where sign-in renews it (`OpenBot-Sign-In`). That is not
 * being signed out: the session still works. The page goes through the hosted sign-in and comes
 * back where it was, with a marker on its address. The person is still signed in to OpenBot by
 * CopilotKit, so the round trip takes no clicks; the page then reads everything again, and says
 * so in case what they were doing needs doing again.
 *
 * A second refusal soon after a round trip means it can't renew by itself (a pop-up blocked, the
 * account signed out there): the person is offered "Sign in again" to that address instead of
 * being sent round in a loop.
 *
 * Imports nothing of the app but the hosted sign-in's address, so the transport (`lib/client.ts`)
 * can call it.
 */
import { HOSTED_SIGN_IN_PATH } from "./hosted";

/** The API's code for a proof that has run out. */
export const RENEWAL_REQUIRED = "HOSTED_SIGN_IN_RENEWAL_REQUIRED";

/** The header that names where sign-in renews it. */
export const SIGN_IN_HEADER = "OpenBot-Sign-In";

/** Where the hosted sign-in starts when the header says nothing usable. */
const HOSTED_SIGN_IN = HOSTED_SIGN_IN_PATH;

/** The marker on the address a renewal comes back to. */
export const RENEWED_MARKER = "openbot-renewed";

/** How long after one round trip another refusal is a loop, not a new expiry. */
const LOOP_WINDOW_MS = 2 * 60_000;

const STARTED = "openbot-renewal-started";

/** Whether a failure is the hosted sign-in needing renewal, which is never being signed out. */
export function renewalRequired(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 401 && code === RENEWAL_REQUIRED;
}

/**
 * Where to send the browser: the sign-in the server named (a path on this OpenBot, else the hosted
 * sign-in's own), returning to `href` with the marker on it.
 */
export function renewalAddress(signIn: string | null, href: string): string {
  const start =
    signIn?.startsWith("/") && !signIn.startsWith("//")
      ? signIn
      : HOSTED_SIGN_IN;
  const back = new URL(href);
  back.searchParams.set(RENEWED_MARKER, "1");
  const address = new URL(start, back.origin);
  address.searchParams.set("returnTo", back.href);
  return `${address.pathname}${address.search}`;
}

type Listener = (address: string) => void;
const listeners = new Set<Listener>();

/** What the page does, kept here so a test can stand in for the browser. */
export const renewalDeps = {
  navigate: (address: string) => window.location.assign(address),
  now: () => Date.now(),
  storage: (): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  },
};

/** Where the write a renewal interrupted waits, to be sent again once the page is back. */
const PENDING = "openbot-renewal-pending";

/**
 * A write the renewal interrupted, exactly as it was sent: its address, method, headers (its
 * Idempotency-Key among them) and body. Sent again once with the same key, so a write that did land
 * the first time is answered as a repeat, never done twice.
 */
export type PendingWrite = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/**
 * The write `init` is, when it can be sent again safely: a write (not a read) carrying an
 * Idempotency-Key, with a body that is text. Null for anything else, which the page reads again
 * instead.
 */
export function pendingWrite(
  path: string,
  init: RequestInit,
): PendingWrite | null {
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    // Lowercase whatever the `Headers` in use gives: header names are case-insensitive.
    headers[name.toLowerCase()] = value;
  });
  if (!headers["idempotency-key"]) return null;
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body !== "string"
  )
    return null;
  return {
    path,
    method,
    headers,
    ...(typeof init.body === "string" ? { body: init.body } : {}),
  };
}

/**
 * Renew: through the hosted sign-in and back, or, where that already happened moments ago, offer
 * "Sign in again" (`onRenewalNeedsClick`). The write that was refused, if it can be sent again, is
 * kept for the page to send once it is back (`takePendingWrite`). Answers which it did.
 */
export function renewHostedSignIn(
  signIn: string | null,
  write: PendingWrite | null = null,
): "sent" | "offered" {
  const address = renewalAddress(signIn, window.location.href);
  const storage = renewalDeps.storage();
  if (write)
    try {
      storage?.setItem(PENDING, JSON.stringify(write));
    } catch {
      // Nowhere to keep it: back from the round trip, the person is told to do it again.
    }
  const started = Number(storage?.getItem(STARTED) ?? 0);
  if (started && renewalDeps.now() - started < LOOP_WINDOW_MS) {
    for (const listener of [...listeners]) listener(address);
    return "offered";
  }
  try {
    storage?.setItem(STARTED, String(renewalDeps.now()));
  } catch {
    // Nowhere to keep it: the next refusal renews again, which is what it would do anyway.
  }
  renewalDeps.navigate(address);
  return "sent";
}

/** Hear when renewing needs the person's click. Returns how to stop. */
export function onRenewalNeedsClick(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether this page is the end of a round trip: its address carries the marker, which is taken off
 * so a reload or a shared link isn't taken for another.
 */
/** The write a round trip interrupted, taken so it is sent once and only once. Null when there is none. */
export function takePendingWrite(): PendingWrite | null {
  const storage = renewalDeps.storage();
  const kept = storage?.getItem(PENDING) ?? null;
  if (kept === null) return null;
  try {
    storage?.removeItem(PENDING);
  } catch {
    // Taken already for this page either way: it is sent once.
  }
  try {
    const write = JSON.parse(kept) as PendingWrite;
    return typeof write?.path === "string" &&
      typeof write.method === "string" &&
      typeof write.headers === "object"
      ? write
      : null;
  } catch {
    return null;
  }
}

export function finishRenewal(): boolean {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RENEWED_MARKER)) return false;
  url.searchParams.delete(RENEWED_MARKER);
  window.history.replaceState(window.history.state, "", url.href);
  return true;
}
