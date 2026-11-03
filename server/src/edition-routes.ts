import type { MiddlewareHandler } from "hono";
import type { Edition } from "./edition";

/**
 * The API the personal edition does not have: what governs other people (who may sign in, their
 * roles, what an organization allows them) and the admin settings it fixes.
 *
 * Each is a path prefix, ending at a segment boundary so `/api/admin/peoplex` is not caught by
 * `/api/admin/people`. Credentials, audit, plugins and computers stay open because the pages that
 * move to Settings call them; they keep their admin guard, and the one person is the admin. So do
 * group conversations (`/api/groups`, several Bots in one conversation), Shared app approvals and
 * Team Bots, which a person's own screens read; the capability switches refuse what the edition
 * turns off.
 */
export const PERSONAL_CLOSED_ROUTES: readonly RegExp[] = [
  "/api/admin/people",
  "/api/admin/identity-providers",
  "/api/admin/enterprise",
  "/api/admin/proactive",
  "/api/admin/learning",
  "/api/auth/scim",
  "/api/auth/sso",
].map((prefix) => new RegExp(`^${prefix}(?:/|$)`));

/** Under a closed prefix and still open: what anybody may ask about their own capabilities. */
const PERSONAL_OPEN_ROUTES: readonly string[] = ["/api/admin/enterprise/me"];

/** A 404 with no body: to the personal edition these routes do not exist. */
export function createEditionGate(edition: Edition): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path;
    if (
      edition === "personal" &&
      !PERSONAL_OPEN_ROUTES.includes(path) &&
      PERSONAL_CLOSED_ROUTES.some((route) => route.test(path))
    ) {
      return context.body(null, 404);
    }
    await next();
  };
}
