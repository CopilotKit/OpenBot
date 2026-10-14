import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  ProductEngineerBusyError,
  ProductEngineerNotFoundError,
  type ProductEngineerRunner,
} from "./runner";
import type { ProductEngineerStore } from "./store";

function runDto(run: Awaited<ReturnType<ProductEngineerStore["get"]>>) {
  if (!run) return null;
  const { startedByUserId: _startedByUserId, ...rest } = run;
  return rest;
}

/**
 * Browser-facing Product Engineer dispatch API.
 * Credentials stay on the server; the page only polls these routes.
 */
export function createProductEngineerRoutes(
  store: ProductEngineerStore,
  runner: ProductEngineerRunner,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/runs", requireUser, async (context) => {
    const runs = await store.list();
    return context.json({ runs: runs.map((run) => runDto(run)) });
  });

  routes.get("/runs/:ticketId", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId").trim().toUpperCase();
    const run = await store.get(ticketId);
    if (!run) {
      return context.json(
        { error: `No Product Engineer run for ${ticketId}.` },
        404,
      );
    }
    return context.json({ run: runDto(run) });
  });

  routes.post("/runs", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    const ticketId = (body as { ticketId?: unknown } | null)?.ticketId;
    if (typeof ticketId !== "string" || !ticketId.trim()) {
      return context.json({ error: "ticketId is required." }, 400);
    }
    try {
      const run = await runner.start(ticketId, context.var.actor.id);
      return context.json({ run: runDto(run) }, 202);
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/runs/:ticketId/resume", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId");
    const body = await context.req.json().catch(() => null);
    const feedback = (body as { feedback?: unknown } | null)?.feedback;
    if (typeof feedback !== "string" || !feedback.trim()) {
      return context.json({ error: "feedback is required." }, 400);
    }
    try {
      const run = await runner.resume(ticketId, feedback.trim());
      return context.json({ run: runDto(run) }, 202);
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/runs/:ticketId/approve", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId");
    try {
      const run = await runner.approve(ticketId);
      return context.json({ run: runDto(run) });
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/runs/:ticketId/approve-plan", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId");
    try {
      const run = await runner.approvePlan(ticketId);
      return context.json({ run: runDto(run) }, 202);
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/runs/:ticketId/reject-plan", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId");
    const body = await context.req.json().catch(() => null);
    const feedback = (body as { feedback?: unknown } | null)?.feedback;
    if (typeof feedback !== "string" || !feedback.trim()) {
      return context.json({ error: "feedback is required." }, 400);
    }
    try {
      const run = await runner.rejectPlan(ticketId, feedback.trim());
      return context.json({ run: runDto(run) });
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/runs/:ticketId/sync", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId");
    try {
      const run = await runner.sync(ticketId);
      return context.json({ run: runDto(run) });
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/runs/:ticketId/abandon", requireUser, async (context) => {
    const ticketId = context.req.param("ticketId");
    const body = await context.req.json().catch(() => null);
    const reason = (body as { reason?: unknown } | null)?.reason;
    try {
      const run = await runner.abandon(
        ticketId,
        typeof reason === "string" ? reason : undefined,
      );
      return context.json({ run: runDto(run) });
    } catch (error) {
      return mapError(context, error);
    }
  });

  return routes;
}

function mapError(
  context: { json: (body: unknown, status?: number) => Response },
  error: unknown,
) {
  if (error instanceof ProductEngineerBusyError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof ProductEngineerNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Expected a Linear identifier/i.test(message)) {
    return context.json({ error: message }, 400);
  }
  if (/Could not find Linear issue|Linear GraphQL/i.test(message)) {
    return context.json({ error: message }, 404);
  }
  if (
    /resume only works|approve only works|approve plan only|revise plan only|no Cursor agent|no plan to approve/i.test(
      message,
    )
  ) {
    return context.json({ error: message }, 409);
  }
  console.error("[product-engineer]", error);
  return context.json({ error: message }, 500);
}
