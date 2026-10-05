import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { DemonstrationRecorder } from "./recording";
import { parseDemonstrationSchedule } from "./schedule";
import type { DemonstrationStore } from "./store";
import { DemonstrationNotFoundError, DemonstrationRefusedError } from "./types";
export function createDemonstrationRoutes(
  store: DemonstrationStore,
  recorder: DemonstrationRecorder,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 8192 }));
  routes.onError((error, context) => {
    if (error instanceof DemonstrationNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof DemonstrationRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "demonstration-route-error",
        error: error.name,
        context: { path: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "The demonstration could not be saved. Try again." },
      503,
    );
  });
  routes.get("/", async (context) =>
    context.json({
      demonstrations: await store.list(
        context.var.actor.id,
        context.req.query("botId") ?? "",
      ),
    }),
  );
  routes.post("/", async (context) => {
    const input = await body(context.req.raw);
    if (typeof input.botId !== "string" || typeof input.title !== "string")
      throw new DemonstrationRefusedError(
        "Choose a Bot and name this demonstration.",
      );
    return context.json(
      {
        demonstration: await recorder.start(
          context.var.actor.id,
          input.botId,
          input.title,
        ),
      },
      201,
    );
  });
  routes.get("/:id", async (context) =>
    context.json({
      demonstration: await store.get(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  routes.post("/:id/stop", async (context) =>
    context.json({
      demonstration: await recorder.stop(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  routes.post("/:id/draft", async (context) =>
    context.json({
      draft: await store.draft(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/published", async (context) => {
    const input = await body(context.req.raw);
    if (typeof input.slug !== "string")
      throw new DemonstrationRefusedError("Choose the saved skill.");
    return context.json({
      demonstration: await recorder.markPublished(
        context.var.actor.id,
        context.req.param("id"),
        input.slug,
      ),
    });
  });
  /** Run the demonstration's saved skill on a schedule, as an ordinary routine. */
  routes.post("/:id/schedule", async (context) => {
    const input = parseDemonstrationSchedule(await body(context.req.raw));
    return context.json(
      {
        routine: await recorder.schedule(
          context.var.actor.id,
          context.req.param("id"),
          input,
        ),
      },
      201,
    );
  });
  routes.delete("/:id", async (context) => {
    await store.remove(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  return routes;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new DemonstrationRefusedError(
      "The demonstration settings could not be read.",
    );
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DemonstrationRefusedError("Supply demonstration settings.");
  return input as Record<string, unknown>;
}
