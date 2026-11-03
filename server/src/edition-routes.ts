import type { MiddlewareHandler } from "hono";
import type { Edition } from "./edition";

/**
 * The API the personal edition does not have: what governs other people (who may sign in, their
 * roles and groups, what an organization allows them), and what shares a Bot with a team.
 *
 * Each is a path prefix, ending at a segment boundary so `/api/admin/peoplex` is not caught by
 * `/api/admin/people`. Credentials, audit, plugins and computers stay open because the pages that
 * move to Settings call them; they keep their admin guard, and the one person is the admin.
 */
export const PERSONAL_CLOSED_ROUTES: readonly RegExp[] = [
  "/api/admin/people",
  "/api/admin/identity-providers",
  "/api/admin/enterprise",
  "/api/admin/proactive",
  "/api/admin/learning",
  "/api/auth/scim",
  "/api/auth/sso",
  "/api/team-bots",
  "/api/groups",
  "/api/approvals/shared-use",
].map((prefix) => new RegExp(`^${prefix}(?:/|$)`));

/** A 404 with no body: to the personal edition these routes do not exist. */
export function createEditionGate(edition: Edition): MiddlewareHandler {
  return async (context, next) => {
    if (
      edition === "personal" &&
      PERSONAL_CLOSED_ROUTES.some((route) => route.test(context.req.path))
    ) {
      return context.body(null, 404);
    }
    await next();
  };
}
