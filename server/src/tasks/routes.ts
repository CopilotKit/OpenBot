import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { TaskResponse, TasksResponse } from "../proactive/contracts";
import type { TaskRunner } from "./runner";
import { TaskNotFoundError, TaskRefusedError, type TaskStore } from "./store";

/**
 * `/api/tasks`: the person's own tasks, as the task list and the "Needs you" list read them. Another
 * person's task is the same as no task. A task's page is its conversation, where the person replies
 * as in any other; these routes are only for where it stands and what the person can do about it.
 */
export function createTaskRoutes(
  store: TaskStore,
  runner: Pick<TaskRunner, "again">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 8_192 }));
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof TaskRefusedError)
      return context.json({ error: error.message }, 409);
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
    context.json<TasksResponse>({
      tasks: await store.list(context.var.actor.id),
    }),
  );
  routes.get("/:id", async (context) =>
    context.json<TaskResponse>({
      task: await store.get(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/resolve", async (context) =>
    context.json<TaskResponse>({
      task: await store.resolve(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/reopen", async (context) =>
    context.json<TaskResponse>({
      task: await store.reopen(context.var.actor.id, context.req.param("id")),
    }),
  );
  /*
   * Try again: the failed turn runs once more, in the task's own conversation. Answered with the task
   * as it stands now, which is Working.
   */
  routes.post("/:id/again", async (context) => {
    const owner = context.var.actor.id;
    const id = context.req.param("id");
    await runner.again(owner, id);
    return context.json<TaskResponse>({ task: await store.get(owner, id) });
  });
  return routes;
}
