import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { HttpCoworkerRoutingService } from "./service";

/**
 * Translate the shared coworker-routing result into the established HTTP contract.
 *
 * Choosing a coworker, applying visibility, invoking the intent model, and recording the canonical
 * audit row are deliberately owned by CoworkerRoutingService. This layer only validates HTTP input
 * and turns its outcome into status codes and JSON.
 */
export function createRoutingRoutes(
  routing: HttpCoworkerRoutingService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
      agentId?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return context.json({ error: "A message is required." }, 400);
    const agentId =
      typeof body?.agentId === "string" && body.agentId.trim()
        ? body.agentId.trim()
        : null;

    const detail = await routing.routeDetailed({
      actor: context.var.actor,
      text,
      agentId,
    });
    const { result } = detail;
    if (result.kind === "none") {
      return context.json(
        {
          error: agentId
            ? "That coworker is not on your roster."
            : "No coworker is available.",
        },
        agentId ? 404 : 409,
      );
    }
    if (result.kind === "ambiguous") {
      return context.json(
        {
          error: "More than one coworker matches that name.",
          names: result.names,
        },
        409,
      );
    }
    const response = {
      agentId: result.agentId,
      name: result.name,
      reason: result.reason,
      fallback: result.fallback,
      viaMention: result.viaMention,
    };
    // The composer chose this coworker directly, and the legacy response did not expose a model
    // fallback cause for that path. Keep the model-routed response shape unchanged below.
    return context.json(
      agentId ? response : { ...response, undecided: detail.undecided },
    );
  });

  return routes;
}
