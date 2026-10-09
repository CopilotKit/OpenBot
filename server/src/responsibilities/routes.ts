import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import { afterExposureChange } from "../plugins/exposure-change";
import type { SharedUseStore } from "../plugins/shared-use-store";
import type { ResponsibilityBindingStore } from "./bindings";
import { inboundAddressFor } from "./email";
import type { ResponsibilityEngine } from "./engine";
import type { TriggerRecord, TriggerStore } from "./triggers";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilityStore,
} from "./types";

/** User-owned goals. Provider events have separately authenticated ingress. */
export function createResponsibilityRoutes(
  store: ResponsibilityStore,
  engine: Pick<ResponsibilityEngine, "ingest">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  bindings?: ResponsibilityBindingStore,
  triggers?: { store: TriggerStore; emailDomain?: string | null },
  sharedUse?: SharedUseStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 64 * 1024 }));
  routes.onError((error, context) => {
    if (error instanceof ResponsibilityNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ResponsibilityRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "responsibility-route-error",
        errorType: error.name,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Responsibilities are unavailable. Try again." },
      503,
    );
  });
  routes.get("/", async (context) =>
    context.json({ responsibilities: await store.list(context.var.actor.id) }),
  );
  if (bindings) {
    routes.get("/sources/github", async (context) =>
      context.json({ bindings: await bindings.list(context.var.actor.id) }),
    );
    routes.post("/sources/github", async (context) => {
      const input = await body(context.req.raw);
      if (
        !input ||
        typeof input !== "object" ||
        !("repository" in input) ||
        typeof input.repository !== "string" ||
        !("secret" in input) ||
        typeof input.secret !== "string"
      )
        throw new ResponsibilityRefusedError(
          "Supply a repository and webhook secret.",
        );
      return context.json(
        {
          binding: await bindings.create(context.var.actor.id, {
            repository: input.repository,
            secret: input.secret,
          }),
        },
        201,
      );
    });
    routes.delete("/sources/github/:bindingId", async (context) => {
      await bindings.remove(
        context.var.actor.id,
        context.req.param("bindingId"),
      );
      return context.body(null, 204);
    });
  }
  if (triggers) {
    const dto = (trigger: TriggerRecord) => ({
      ...trigger,
      path:
        trigger.kind === "email" || trigger.kind === "slack"
          ? null
          : `/api/events/triggers/${trigger.id}`,
      address:
        trigger.kind === "email" && triggers.emailDomain
          ? inboundAddressFor(trigger.id, triggers.emailDomain)
          : null,
      emailConfigured:
        trigger.kind === "email" ? !!triggers.emailDomain : undefined,
    });
    routes.get("/:id/triggers", async (context) =>
      context.json({
        triggers: (
          await triggers.store.list(
            context.var.actor.id,
            context.req.param("id"),
          )
        ).map(dto),
      }),
    );
    routes.post("/:id/triggers", async (context) => {
      const input = await body(context.req.raw);
      if (!input || typeof input !== "object" || !("config" in input))
        throw new ResponsibilityRefusedError("Supply a trigger config.");
      const secret =
        "secret" in input && typeof input.secret === "string" && input.secret
          ? input.secret
          : undefined;
      const created = await triggers.store.create(
        context.var.actor.id,
        context.req.param("id"),
        { config: input.config, secret },
      );
      /* A new trigger can widen whose input steers a shared app, so it gets the same say-what's-missing treatment as publishing. */
      const botId = await sharedUse?.botForResponsibility(
        context.req.param("id"),
      );
      return context.json(
        {
          trigger: dto(created.trigger),
          secret: created.secret,
          ...(botId
            ? {
                sharedApps: await afterExposureChange(
                  sharedUse,
                  context.var.actor,
                  botId,
                ),
              }
            : {}),
        },
        201,
      );
    });
    routes.patch("/triggers/:triggerId", async (context) => {
      const input = await body(context.req.raw);
      if (!input || typeof input !== "object" || !("config" in input))
        throw new ResponsibilityRefusedError("Supply a trigger config.");
      const updated = await triggers.store.update(
        context.var.actor.id,
        context.req.param("triggerId"),
        { config: input.config },
      );
      const botId = await sharedUse?.botForResponsibility(
        updated.responsibilityId,
      );
      return context.json({
        trigger: dto(updated),
        ...(botId
          ? {
              sharedApps: await afterExposureChange(
                sharedUse,
                context.var.actor,
                botId,
              ),
            }
          : {}),
      });
    });
    routes.post("/triggers/:triggerId/secret", async (context) => {
      const input = context.req.header("content-type")
        ? await body(context.req.raw)
        : {};
      const pasted =
        input &&
        typeof input === "object" &&
        "secret" in input &&
        typeof input.secret === "string"
          ? input.secret
          : undefined;
      const rotated = await triggers.store.setSecret(
        context.var.actor.id,
        context.req.param("triggerId"),
        pasted,
      );
      return context.json({
        trigger: dto(rotated.trigger),
        secret: rotated.secret,
      });
    });
    routes.put("/triggers/:triggerId/enabled", async (context) => {
      const input = await body(context.req.raw);
      if (
        !input ||
        typeof input !== "object" ||
        !("enabled" in input) ||
        typeof input.enabled !== "boolean"
      )
        throw new ResponsibilityRefusedError("enabled must be true or false.");
      return context.json({
        trigger: dto(
          await triggers.store.setEnabled(
            context.var.actor.id,
            context.req.param("triggerId"),
            input.enabled,
          ),
        ),
      });
    });
    routes.get("/triggers/:triggerId/secret", async (context) =>
      context.json({
        secret: await triggers.store.revealSecret(
          context.var.actor.id,
          context.req.param("triggerId"),
        ),
      }),
    );
    routes.delete("/triggers/:triggerId", async (context) => {
      await triggers.store.remove(
        context.var.actor.id,
        context.req.param("triggerId"),
      );
      return context.body(null, 204);
    });
  }
  routes.post("/", async (context) => {
    const responsibility = await store.create(
      context.var.actor.id,
      await body(context.req.raw),
    );
    return context.json(
      {
        responsibility,
        sharedApps: await afterExposureChange(
          sharedUse,
          context.var.actor,
          responsibility.agentId,
        ),
      },
      201,
    );
  });
  routes.get("/:id", async (context) =>
    context.json({
      responsibility: await store.get(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  routes.patch("/:id", async (context) => {
    const responsibility = await store.update(
      context.var.actor.id,
      context.req.param("id"),
      await body(context.req.raw),
    );
    return context.json({
      responsibility,
      sharedApps: await afterExposureChange(
        sharedUse,
        context.var.actor,
        responsibility.agentId,
      ),
    });
  });
  routes.get("/:id/runs", async (context) =>
    context.json({
      runs: await store.listRuns(context.var.actor.id, context.req.param("id")),
    }),
  );
  for (const [action, status] of [
    ["pause", "paused"],
    ["resume", "active"],
    ["complete", "completed"],
  ] as const) {
    routes.post(`/:id/${action}`, async (context) =>
      context.json({
        responsibility: await store.transition(
          context.var.actor.id,
          context.req.param("id"),
          status,
        ),
      }),
    );
  }
  routes.post("/:id/run", async (context) => {
    const goal = await store.get(context.var.actor.id, context.req.param("id"));
    // Run now does real work, and a paused or completed responsibility never runs.
    if (goal.status !== "active")
      throw new ResponsibilityRefusedError(
        `This responsibility is ${goal.status}. Resume it before running it.`,
      );
    const event = await engine.ingest({
      ownerUserId: context.var.actor.id,
      responsibilityId: context.req.param("id"),
      source: "manual",
      externalId: randomUUID(),
      type: "requested",
      payload: {},
    });
    return context.json(event, 202);
  });
  routes.post("/:id/progress", async (context) => {
    const input = await body(context.req.raw);
    if (
      !input ||
      typeof input !== "object" ||
      !("summary" in input) ||
      typeof input.summary !== "string"
    )
      throw new ResponsibilityRefusedError("Supply a progress summary.");
    return context.json({
      responsibility: await store.recordProgress(
        context.var.actor.id,
        context.req.param("id"),
        { summary: input.summary },
      ),
    });
  });
  // Continuations deliberately have no generic public endpoint: approval/person routes first
  // validate the stored question/action, then call resumeWaiting with the verified tool result.
  return routes;
}

async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ResponsibilityRefusedError("Send a JSON request.");
  try {
    return await request.json();
  } catch {
    throw new ResponsibilityRefusedError("The JSON request could not be read.");
  }
}
