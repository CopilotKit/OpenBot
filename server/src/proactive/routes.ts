import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { ProactiveEngine } from "./engine";
import type { ProactiveStore } from "./store";
import { ProactiveNotFoundError, ProactiveRefusedError } from "./types";

/** `/api/proactive`: a person's background-research settings and the suggestions they produced. */
export function createProactiveRoutes(
  store: ProactiveStore,
  engine: ProactiveEngine,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 8_192 }));
  routes.onError((error, context) => {
    if (error instanceof ProactiveNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ProactiveRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "proactive-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Background research is unavailable. Try again." },
      503,
    );
  });
  routes.get("/settings", async (context) =>
    context.json({ settings: await store.list(context.var.actor.id) }),
  );
  routes.post("/settings", async (context) =>
    context.json(
      {
        setting: await engine.create(
          context.var.actor.id,
          await body(context.req.raw),
        ),
      },
      201,
    ),
  );
  routes.patch("/settings/:id", async (context) =>
    context.json({
      setting: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        await body(context.req.raw),
      ),
    }),
  );
  routes.post("/settings/:id/run", async (context) =>
    context.json(
      await engine.runNow(context.var.actor.id, context.req.param("id")),
    ),
  );
  routes.delete("/settings/:id", async (context) => {
    await store.remove(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  routes.get("/suggestions", async (context) =>
    context.json({
      suggestions: await store.suggestions(context.var.actor.id),
    }),
  );
  routes.post("/suggestions/:id/start", async (context) =>
    context.json({
      suggestion: await engine.start(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  routes.post("/suggestions/:id/dismiss", async (context) =>
    context.json({
      suggestion: await engine.dismiss(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  return routes;
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ProactiveRefusedError("Supply JSON settings.");
  try {
    return await request.json();
  } catch {
    throw new ProactiveRefusedError("The settings could not be read.");
  }
}
