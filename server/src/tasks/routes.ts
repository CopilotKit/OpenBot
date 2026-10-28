import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { TaskStore } from "./store";
import { TaskNotFoundError } from "./types";

/** `/api/tasks`: the person's own tasks, as Tasks and the task page read them. */
export function createTaskRoutes(
  store: TaskStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    console.error(
      JSON.stringify({
        type: "tasks-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Couldn't load your tasks. Try again." }, 503);
  });
  routes.get("/", async (context) =>
    context.json({ tasks: await store.list(context.var.actor.id) }),
  );
  routes.get("/:id", async (context) =>
    context.json({
      task: await store.get(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/resolve", async (context) =>
    context.json({
      task: await store.resolve(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/reopen", async (context) =>
    context.json({
      task: await store.reopen(context.var.actor.id, context.req.param("id")),
    }),
  );
  return routes;
}
