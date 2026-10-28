import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "../desktop-connection-failure";
import type { AuthenticatedActor, AuthService } from "./guards";

export const ORGANIZATION_SESSION_COOKIE = "openbot.organization-session";
const COOKIE = ORGANIZATION_SESSION_COOKIE;
const HANDOFF_PATH = "/api/auth/organization/session";
/** How long the organization session cookie lasts, in seconds: its Max-Age, set once at the handoff and never renewed,
 * so a person signs in to their organization again after this. The cookie says when it expires (`expiresAt`), and a
 * Recorder connection made with it ends then too (recorder/wiring.ts), since it carries a sealed copy of it. */
export const ORGANIZATION_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_AGE = ORGANIZATION_SESSION_MAX_AGE_SECONDS;
/** What the person is told when their sign-out could not end everything they were signed in with, and so did not happen. */
export const SIGN_OUT_UNFINISHED = "Signing out did not finish. Try again.";
export class AuthorityUnavailable extends Error {}

/** The organization session cookie's own record: the authority it is for, the authority's session cookie, and when it
 * expires (epoch milliseconds). A cookie set before the expiry was written into it has none. */
function organizationRecord(
  value: string,
): { authority: unknown; cookie: unknown; expiresAt?: unknown } | null {
  try {
    const record: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    return record &&
      typeof record === "object" &&
      "authority" in record &&
      "cookie" in record
      ? record
      : null;
  } catch {
    return null;
  }
}

/**
 * When an organization session cookie (its value, as the browser sends it) expires: the expiry it carries, and never
 * later than its Max-Age from `now`, since no cookie was set in the future and the record is the browser's to edit.
 * A cookie set before the expiry was written into it is given that Max-Age from now, which none outlives.
 */
export function organizationCookieExpiresAt(
  value: string,
  now: number = Date.now(),
): Date {
  const latest = now + COOKIE_AGE * 1_000;
  const expiresAt = organizationRecord(value)?.expiresAt;
  return new Date(
    typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? Math.min(expiresAt, latest)
      : latest,
  );
}

/** Explicit customer OpenBot authority, never inferred from an Intelligence endpoint. */
export function organizationAuthority(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Organization sign-in requires an HTTPS OpenBot origin (HTTP is allowed only on loopback).",
    );
  }
  return url.origin;
}

function actor(value: unknown): AuthenticatedActor | null {
  if (!value || typeof value !== "object" || !("user" in value)) return null;
  const user = value.user;
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    !("email" in user) ||
    !("role" in user)
  )
    return null;
  if (
    typeof user.id !== "string" ||
    !user.id ||
    user.id === "dev-local-user" ||
    typeof user.email !== "string" ||
    !user.email ||
    (user.role !== "admin" && user.role !== "user")
  )
    return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: "name" in user && typeof user.name === "string" ? user.name : null,
    image:
      "image" in user && typeof user.image === "string" ? user.image : null,
  };
}

/** Only the signed session cookie is forwarded; local app cookies never leave this server. */
function sessionCookie(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 8192 &&
    /^(?:__Secure-)?better-auth\.session_token=[^;\s\r\n]+$/.test(value)
  );
}

export function createOrganizationAuth(options: {
  authorityUrl: string;
  materializeUser: (user: AuthenticatedActor) => Promise<AuthenticatedActor>;
  /**
   * Ends what else the person is signed in with here (their Recorder connections, index.ts) when they sign out, before
   * the organization is asked to end their session. Throws when it could not, and then the sign-out does not happen:
   * see the sign-out route below.
   */
  signOutRecorders?: (userId: string, ending: string) => Promise<void>;
}): AuthService & {
  verifySessionQuietly: (
    cookieHeader: string,
  ) => Promise<AuthenticatedActor | null>;
} {
  const authority = organizationAuthority(options.authorityUrl);
  const tickets = new Map<string, { cookie: string; expires: number }>();

  type Verdict =
    | { kind: "actor"; actor: AuthenticatedActor }
    | { kind: "refused"; authenticationFailed: boolean }
    | { kind: "unexpected"; status: number };

  /** Asks the organization about a cookie and reports what it said, with no side effects on Desktop's failure state. */
  async function verifyAtAuthority(cookie: string): Promise<Verdict> {
    if (!sessionCookie(cookie))
      return { kind: "refused", authenticationFailed: false };
    let response: Response;
    try {
      response = await fetch(`${authority}/api/me`, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AuthorityUnavailable(
        "The organization could not be reached. Try again.",
      );
    }
    if (response.status >= 500)
      throw new AuthorityUnavailable(
        "The organization is temporarily unavailable. Try again.",
      );
    if (response.status === 401 || response.status === 403)
      return { kind: "refused", authenticationFailed: true };
    if (!response.ok) return { kind: "unexpected", status: response.status };
    const user = actor(await response.json().catch(() => null));
    if (!user) return { kind: "unexpected", status: response.status };
    return { kind: "actor", actor: await options.materializeUser(user) };
  }

  async function verify(cookie: string): Promise<AuthenticatedActor | null> {
    const verdict = await verifyAtAuthority(cookie);
    if (verdict.kind === "refused") {
      if (verdict.authenticationFailed)
        recordDesktopConnectionFailure({
          connection: "organization",
          code: "organization_authentication_failed",
        });
      return null;
    }
    if (verdict.kind === "unexpected") return null;
    clearDesktopConnectionFailure("organization");
    return verdict.actor;
  }

  function cookieFrom(headers: Headers): string | null {
    const encoded = headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!encoded || encoded.length > 12000) return null;
    const record = organizationRecord(encoded);
    // Binding the cookie to the authority prevents a changed organization setting reusing it.
    if (
      !record ||
      record.authority !== authority ||
      !sessionCookie(record.cookie)
    )
      return null;
    // Past its own expiry it is not taken, wherever it was kept: the browser drops it then, and a sealed copy
    // (recorder/wiring.ts) must not be worth more than the cookie it copies.
    if (typeof record.expiresAt === "number" && record.expiresAt <= Date.now())
      return null;
    return record.cookie;
  }

  const getSession: AuthService["api"]["getSession"] = async ({ headers }) => {
    const cookie = cookieFrom(headers);
    if (!cookie)
      recordDesktopConnectionFailure({
        connection: "organization",
        code: "organization_authentication_failed",
      });
    const user = cookie ? await verify(cookie) : null;
    return user ? { user } : null;
  };

  /** Verifies a forwarded cookie header without touching Desktop's failure state; an odd answer is unavailable, never a sign-out. */
  async function verifySessionQuietly(
    cookieHeader: string,
  ): Promise<AuthenticatedActor | null> {
    const cookie = cookieFrom(new Headers({ cookie: cookieHeader }));
    if (!cookie) return null;
    const verdict = await verifyAtAuthority(cookie);
    if (verdict.kind === "actor") return verdict.actor;
    if (verdict.kind === "refused") return null;
    throw new AuthorityUnavailable(
      "The organization gave an answer OpenBot could not read. Try again.",
    );
  }

  return {
    api: { getSession },
    verifySessionQuietly,
    async handler(request) {
      try {
        const url = new URL(request.url);
        const json = (body: unknown, status = 200) =>
          Response.json(body, {
            status,
            headers: { "cache-control": "no-store" },
          });
        const unavailable = () =>
          json(
            {
              error: "Sign in to your organization again.",
              connection: "organization",
            },
            401,
          );
        const allowedOrigin = () => {
          const origin = request.headers.get("origin");
          if (origin === url.origin) return true;
          try {
            const source = new URL(origin ?? "");
            const loopback = (value: URL) =>
              value.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname);
            return (
              source.origin === origin && loopback(source) && loopback(url)
            );
          } catch {
            return false;
          }
        };
        if (url.origin === authority) return unavailable();
        if (url.pathname === HANDOFF_PATH && request.method === "POST") {
          // Native supplies this exact Origin; a foreign browser cannot deliver a login via CSRF.
          if (!allowedOrigin()) return json({ error: "Origin refused." }, 403);
          const body: unknown = await request.json().catch(() => null);
          if (
            !body ||
            typeof body !== "object" ||
            !("cookie" in body) ||
            !sessionCookie(body.cookie) ||
            !(await verify(body.cookie))
          )
            return unavailable();
          const now = Date.now();
          for (const [key, ticket] of tickets)
            if (ticket.expires <= now) tickets.delete(key);
          if (tickets.size >= 32)
            return json({ error: "Too many pending sign-ins." }, 429);
          const ticket = crypto.randomUUID();
          tickets.set(ticket, { cookie: body.cookie, expires: now + 60_000 });
          return json({ ticket });
        }
        if (url.pathname === HANDOFF_PATH && request.method === "GET") {
          const key = url.searchParams.get("ticket") ?? "";
          const ticket = tickets.get(key);
          tickets.delete(key);
          if (
            !ticket ||
            ticket.expires <= Date.now() ||
            !(await verify(ticket.cookie))
          )
            return unavailable();
          const value = Buffer.from(
            JSON.stringify({
              authority,
              cookie: ticket.cookie,
              expiresAt: Date.now() + COOKIE_AGE * 1_000,
            }),
          ).toString("base64url");
          return new Response(null, {
            status: 303,
            headers: {
              location: "/",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "set-cookie": `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_AGE}${url.protocol === "https:" ? "; Secure" : ""}`,
            },
          });
        }
        if (url.pathname === "/api/auth/get-session")
          return json(
            await getSession({
              headers: request.headers,
              query: { disableCookieCache: true },
            }),
          );
        if (
          url.pathname === "/api/auth/sign-out" &&
          request.method === "POST"
        ) {
          if (!allowedOrigin()) return json({ error: "Origin refused." }, 403);
          const cookie = cookieFrom(request.headers);
          if (cookie) {
            // Who is signing out, asked before the session ends: afterwards the organization no longer says.
            const before = await verifyAtAuthority(cookie);
            /*
             * Their Recorders first, and the sign-out only once they have ended: a sign-out that answered success with a
             * Recorder still signed in as them would be the one thing it must not be. When they could not be ended
             * (signOutRecorders has retried, and written the security row), nothing has changed: the person is told,
             * still signed in, and signing out again tries it all again.
             */
            if (before.kind === "actor" && options.signOutRecorders) {
              try {
                await options.signOutRecorders(
                  before.actor.id,
                  "organization-sign-out",
                );
              } catch {
                return json({ error: SIGN_OUT_UNFINISHED }, 503);
              }
            }
            try {
              const response = await fetch(`${authority}/api/auth/sign-out`, {
                method: "POST",
                headers: {
                  cookie,
                  origin: authority,
                  "content-type": "application/json",
                },
                body: "{}",
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
              });
              if (!response.ok)
                throw new AuthorityUnavailable("Sign-out was not accepted.");
            } catch {
              return json(
                { error: "The organization could not be reached to sign out." },
                503,
              );
            }
          }
          return Response.json(
            { success: true },
            {
              headers: {
                "cache-control": "no-store",
                "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
              },
            },
          );
        }
        return json(
          { error: "Use the OpenBot organization sign-in screen." },
          404,
        );
      } catch (error) {
        if (!(error instanceof AuthorityUnavailable)) throw error;
        return Response.json(
          { error: error.message },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    },
  };
}
