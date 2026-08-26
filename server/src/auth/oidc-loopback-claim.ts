/**
 * One-shot session handoff after Grok Build's CORS loopback callback.
 *
 * accounts.x.ai delivers the auth code with `fetch()` onto 127.0.0.1. The
 * browser treats that as a third-party request, so Better Auth's Set-Cookie
 * does not become the OpenBot page's session. The API keeps the cookies here
 * for a short window; the sign-in page claims them first-party through Vite.
 */

const CLAIM_TTL_MS = 2 * 60 * 1000;

type PendingClaim = {
  cookies: string[];
  expiresAt: number;
};

let pending: PendingClaim | null = null;

export function stashOidcLoopbackCookies(setCookies: string[]): boolean {
  const session = setCookies.filter((cookie) => /session_token=/i.test(cookie));
  if (session.length === 0) {
    return false;
  }
  pending = {
    cookies: setCookies,
    expiresAt: Date.now() + CLAIM_TTL_MS,
  };
  return true;
}

export function claimOidcLoopbackCookies(): string[] | null {
  const held = pending;
  pending = null;
  if (!held || held.expiresAt < Date.now()) {
    return null;
  }
  return held.cookies;
}

export function hasOidcLoopbackClaim(): boolean {
  return pending !== null && pending.expiresAt >= Date.now();
}
