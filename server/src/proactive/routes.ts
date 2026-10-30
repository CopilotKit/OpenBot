import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import { plainFailure } from "../tasks/state";
import type { ProactiveEngine } from "./engine";
import {
  type ProactiveRunRow,
  type ProactiveStore,
  STOPPED_BEFORE_FINISHING,
} from "./store";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
  type ProactiveSuggestion,
  SKIPPED_BECAUSE,
} from "./types";

/**
 * An item as the person's app reads it (`SuggestionPayload` once it is JSON). Its normalized title
 * is the repeat check's business, not theirs.
 */
function payloadOf({ dedupeKey: _, ...item }: ProactiveSuggestion) {
  return item;
}

/**
 * A setting's newest check-in as the person reads it (`LastCheckInPayload`): how it ended and, for
 * one that was skipped or couldn't finish, why, in one plain sentence. Never the error itself, which
 * is an operator's and can be a status code or a stack: the same plain words a task uses.
 */
function lastRunOf(run: ProactiveRunRow | undefined) {
  if (!run) return null;
  const why =
    run.outcome === "skipped" && run.skipReason
      ? SKIPPED_BECAUSE[run.skipReason]
      : run.outcome === "failed"
        ? `Couldn't finish: ${plainFailure(run.error === STOPPED_BEFORE_FINISHING ? null : run.error)}.`
        : null;
  return {
    outcome: run.outcome,
    trigger: run.trigger,
    skipReason: run.skipReason,
    why,
    itemsRaised: run.itemsRaised,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/** `/api/proactive`: a person's check-in settings and the items their Bots raised. */
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
      { error: "Check-ins aren't available right now. Try again." },
      503,
    );
  });
  routes.get("/settings", async (context) => {
    const [settings, runs, allowed] = await Promise.all([
      store.list(context.var.actor.id),
      store.latestRuns(context.var.actor.id),
      engine.allowed(context.var.actor.id),
    ]);
    return context.json({
      settings: settings.map((setting) => ({
        ...setting,
        lastRun: lastRunOf(runs.get(setting.id)),
      })),
      allowed,
    });
  });
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
      suggestions: (await store.suggestions(context.var.actor.id)).map(
        payloadOf,
      ),
    }),
  );
  routes.post("/suggestions/:id/start", async (context) => {
    const { suggestion, task } = await engine.start(
      context.var.actor.id,
      context.req.param("id"),
    );
    return context.json({ suggestion: payloadOf(suggestion), task });
  });
  routes.post("/suggestions/:id/dismiss", async (context) =>
    context.json({
      suggestion: payloadOf(
        await engine.dismiss(context.var.actor.id, context.req.param("id")),
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
