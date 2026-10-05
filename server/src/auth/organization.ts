import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "../desktop-connection-failure";
import type { AuthenticatedActor, AuthService } from "./guards";

const COOKIE = "openbot.organization-session";
const HANDOFF_PATH = "/api/auth/organization/session";
const COOKIE_AGE = 7 * 24 * 60 * 60;
class AuthorityUnavailable extends Error {}

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
}): AuthService {
  const authority = organizationAuthority(options.authorityUrl);
  const tickets = new Map<string, { cookie: string; expires: number }>();

  async function verify(cookie: string): Promise<AuthenticatedActor | null> {
    if (!sessionCookie(cookie)) return null;
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
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        recordDesktopConnectionFailure({
          connection: "organization",
          code: "organization_authentication_failed",
        });
      return null;
    }
    const user = actor(await response.json().catch(() => null));
    if (!user) return null;
    const localUser = await options.materializeUser(user);
    clearDesktopConnectionFailure("organization");
    return localUser;
  }

  function cookieFrom(headers: Headers): string | null {
    const encoded = headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!encoded || encoded.length > 12000) return null;
    try {
      // Binding the cookie to the authority prevents a changed organization setting reusing it.
      const record: unknown = JSON.parse(
        Buffer.from(encoded, "base64url").toString(),
      );
      if (
        !record ||
        typeof record !== "object" ||
        !("authority" in record) ||
        record.authority !== authority ||
        !("cookie" in record) ||
        !sessionCookie(record.cookie)
      )
        return null;
      return record.cookie;
    } catch {
      return null;
    }
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

  return {
    api: { getSession },
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
            JSON.stringify({ authority, cookie: ticket.cookie }),
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
