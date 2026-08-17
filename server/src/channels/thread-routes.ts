import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { ThreadIdentity } from "./thread-identity";

/**
 * A thread id for a conversation this deployment keeps no channel for.
 *
 * The direct Bot chat is CopilotKit's own component, and left to itself it generates an id in the
 * browser that says nothing about where the conversation came from. Minting it here puts those
 * threads in the same namespace as every channel's, so one project shared by two deployments can
 * still tell whose conversations are whose.
 *
 * Behind the session guard because a thread id is the name of somewhere a conversation will be
 * stored, and there is no reason for anybody signed out to be handed one.
 */
export function createThreadRoutes(
  identity: ThreadIdentity,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/mint", requireUser, (context) =>
    context.json({ threadId: identity.mint() }),
  );

  return routes;
}
