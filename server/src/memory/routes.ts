import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { MemoryIngestion } from "./ingestion";
import type { MemoryStore } from "./store";
import { MemoryNotFoundError, MemoryRefusedError } from "./types";

export function createMemoryRoutes(
  store: MemoryStore,
  ingestion: MemoryIngestion,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof MemoryNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof MemoryRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "memory-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Memory is unavailable. Try again." }, 503);
  });
  routes.get("/", async (context) =>
    context.json({ memories: await store.list(context.var.actor.id) }),
  );
  routes.post("/", async (context) =>
    context.json(
      {
        memory: await store.create(
          context.var.actor.id,
          await body(context.req.raw),
        ),
      },
      201,
    ),
  );
  routes.get("/sources", async (context) =>
    context.json({ sources: await store.sources(context.var.actor.id) }),
  );
  routes.get("/sources/available/:botId", async (context) =>
    context.json({
      tools: await ingestion.availableSources(
        context.var.actor.id,
        context.req.param("botId"),
      ),
    }),
  );
  routes.post("/sources", async (context) =>
    context.json(
      await ingestion.createSource(
        context.var.actor.id,
        await body(context.req.raw),
      ),
      201,
    ),
  );
  routes.patch("/sources/:id", async (context) => {
    const input = await body(context.req.raw);
    if (
      !input ||
      typeof input !== "object" ||
      !("enabled" in input) ||
      typeof input.enabled !== "boolean"
    )
      throw new MemoryRefusedError("Choose whether this source is enabled.");
    return context.json({
      source: await store.setSourceEnabled(
        context.var.actor.id,
        context.req.param("id"),
        input.enabled,
      ),
    });
  });
  routes.post("/sources/:id/sync", async (context) =>
    context.json(
      await ingestion.sync(context.var.actor.id, context.req.param("id")),
    ),
  );
  routes.delete("/sources/:id", async (context) => {
    await store.removeSource(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  routes.patch("/:id", async (context) =>
    context.json({
      memory: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        await body(context.req.raw),
      ),
    }),
  );
  routes.delete("/:id", async (context) => {
    await store.remove(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  return routes;
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new MemoryRefusedError("Supply JSON memory settings.");
  try {
    return await request.json();
  } catch {
    throw new MemoryRefusedError("The memory settings could not be read.");
  }
}
