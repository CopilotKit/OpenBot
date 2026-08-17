import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { DATA_FUNCTIONS, dataFunction } from "./functions";
import { ComponentNotFoundError, type ComponentStore } from "./store";

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id would fail the constraint and
 * lose the row entirely. Who it was is in the payload either way.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * Granting, publishing and asking whether a Bot may use a component.
 *
 * Reading is open to any signed-in person; changing is not. Which components a Bot holds is what the
 * surface in front of that person is built from, and what a Bot may do is not a secret from the
 * person talking to it. Deciding it is an administrator's job.
 *
 * The decision endpoint is the part that matters. The app already knows what it registered, so
 * asking again before every render looks redundant, and is not. The list of tools a run is offered
 * is a snapshot taken when that run started, so a grant revoked one second later is still in the
 * model's hands. Asking at call time is what makes "revoke it and watch it go" true rather than
 * nearly true, and it is where a refusal becomes a row somebody can see.
 */
export function createComponentRoutes(
  store: ComponentStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const audit = async (
    context: { var: AppVariables },
    eventType: Parameters<typeof recordAuditEvent>[1]["eventType"],
    targetId: string,
    payload: Record<string, unknown>,
  ) => {
    if (!auditStore) return;
    const actor = context.var.actor;
    await recordAuditEvent(auditStore, {
      eventType,
      targetType: "component",
      targetId,
      ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
        ? { actorUserId: actor.id }
        : {}),
      payload: { actor: actor?.email ?? "unknown", ...payload },
    });
  };

  /** Everything a person needs to see the whole grant surface at once. */
  routes.get("/", requireUser, async (context) =>
    context.json({ components: await store.list() }),
  );

  /**
   * A build announcing what it can draw.
   *
   * The build knows what exists; this deployment decides what it may do. A component is an ordinary
   * React file, so the only thing that can truthfully enumerate them is the app that compiled them.
   * A second list kept here would be a copy to keep in step, and the first thing to fall out of it.
   * Drop a file in and it appears here, published, and any Bot may draw it until somebody says
   * otherwise.
   *
   * Additive only, and not an administrator action: any signed-in person's browser announces it on
   * load, and it cannot change who may use a component, its publication state or its description.
   */
  routes.put("/catalogue", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      components?: unknown;
    } | null;
    const entries = Array.isArray(body?.components) ? body.components : null;
    if (!entries) {
      return context.json({ error: "A list of components is required." }, 400);
    }

    const valid = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { name, title, kind, description } = entry as Record<
        string,
        unknown
      >;
      if (
        typeof name !== "string" ||
        !name ||
        typeof title !== "string" ||
        typeof kind !== "string" ||
        typeof description !== "string" ||
        !description
      ) {
        return [];
      }
      return [{ name, title, kind, description }];
    });

    const { added } = await store.syncCatalogue(valid);
    // Only arrivals are recorded. Announcing happens on every page load, and a row per load would
    // bury the trail it is written into.
    for (const name of added) {
      await audit(context, "component.published", name, {
        note: "First seen in a build, published and available to every Bot.",
      });
    }
    return context.json({ added });
  });

  /**
   * What one Bot holds. Polled by the app, which turns it into the tools that Bot is offered.
   *
   * Deliberately says nothing about the components this Bot does NOT hold. A list of everything it
   * is missing would be a list the surface could accidentally register.
   */
  routes.get("/for-agent/:agentId", requireUser, async (context) =>
    context.json({
      components: await store.listForAgent(context.req.param("agentId")),
    }),
  );

  /**
   * May this Bot use this component, right now?
   *
   * A POST because it writes: a refusal is recorded. Answering 200 with `allowed: false` rather than
   * 403 is deliberate, the caller is the app asking a question on the Bot's behalf, and it is not
   * itself forbidden from asking. The refusal travels in the body, where the handler turns it into
   * something the model reads.
   */
  routes.post("/:name/decision", requireUser, async (context) => {
    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
      functions?: unknown;
    } | null;
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    if (!agentId) {
      return context.json({ error: "The Bot is required." }, 400);
    }
    const functions = Array.isArray(body?.functions)
      ? body.functions.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];

    const decision = await store.decide(name, agentId);
    if (!decision.allowed) {
      await audit(context, "component.refused", name, {
        bot: agentId,
        reason: decision.reason,
      });
      return context.json({ allowed: false, reason: decision.reason });
    }

    /*
     * The data the component will read, decided here as well.
     *
     * Both decisions are enforced at `/call`, but that runs while the component renders, after
     * whoever asked for it has been answered. A caller that says which functions the component
     * needs gets one verdict covering what it will do, rather than one covering only its name.
     */
    for (const functionName of functions) {
      if (await store.mayCall(name, functionName)) continue;
      const reason = `${name} has not been granted the function ${functionName}. An administrator grants each function to each component.`;
      await audit(context, "component.function_refused", name, {
        bot: agentId,
        function: functionName,
        reason,
      });
      return context.json({ allowed: false, reason });
    }

    return context.json({ allowed: true });
  });

  /** The data functions this build ships, for an administrator deciding what to grant. */
  routes.get("/functions", requireUser, (context) =>
    context.json({
      functions: DATA_FUNCTIONS.map((entry) => ({
        name: entry.name,
        description: entry.description,
        reads: entry.reads,
      })),
    }),
  );

  /**
   * A component fetching its own data.
   *
   * Permission is enforced here. A compiled React component has
   * the whole application and could call any endpoint directly, so an allow-list held beside it in
   * the browser is documentation. The only place that can refuse is the place holding the data.
   *
   * Two decisions are enforced: whether this Bot may use the component at all, and whether the
   * component may call this particular function. Passing one is not passing the other.
   */
  routes.post("/:name/call", requireUser, async (context) => {
    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      function?: unknown;
      args?: unknown;
      agentId?: unknown;
    } | null;
    const functionName =
      typeof body?.function === "string" ? body.function : "";
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    if (!functionName || !agentId) {
      return context.json(
        { error: "The function and the Bot are both required." },
        400,
      );
    }

    const refuse = async (reason: string) => {
      await audit(context, "component.function_refused", name, {
        bot: agentId,
        function: functionName,
        reason,
      });
      return context.json({ allowed: false, reason });
    };

    // The component itself, first. A component this Bot may not use may not read on its behalf.
    const decision = await store.decide(name, agentId);
    if (!decision.allowed) return refuse(decision.reason);

    const fn = dataFunction(functionName);
    if (!fn) {
      // Named separately from a refusal so an administrator is not sent looking for a grant to give
      // for something this build does not have.
      return refuse(
        `There is no data function called ${functionName} in this deployment.`,
      );
    }

    if (!(await store.mayCall(name, functionName))) {
      return refuse(
        `${name} has not been granted the function ${functionName}. An administrator grants each function to each component.`,
      );
    }

    try {
      const data = await store.callFunction(
        functionName,
        (body?.args ?? {}) as Record<string, unknown>,
      );
      await audit(context, "component.function_called", name, {
        bot: agentId,
        function: functionName,
        reads: fn.reads,
      });
      return context.json({ allowed: true, data });
    } catch (error) {
      // A function that threw is not a refusal and must not read as one: nothing was forbidden, the
      // read failed. Recorded as its own thing so a broken query is not filed as a policy event.
      await audit(context, "component.function_failed", name, {
        bot: agentId,
        function: functionName,
        failure: error instanceof Error ? error.message : "The read failed.",
      });
      return context.json(
        { allowed: true, error: "That data could not be read." },
        502,
      );
    }
  });

  routes.post("/:name/functions", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      function?: unknown;
    } | null;
    const functionName =
      typeof body?.function === "string" ? body.function : "";
    if (!functionName || !dataFunction(functionName)) {
      return context.json(
        { error: "A function this deployment ships is required." },
        400,
      );
    }

    try {
      await store.grantFunction(name, functionName, context.var.actor.email);
    } catch (error) {
      if (error instanceof ComponentNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }

    await audit(context, "component.function_granted", name, {
      function: functionName,
    });
    return context.json({ granted: true });
  });

  routes.delete("/:name/functions/:function", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const name = context.req.param("name");
    const functionName = context.req.param("function");
    await store.revokeFunction(name, functionName);
    await audit(context, "component.function_revoked", name, {
      function: functionName,
    });
    return context.json({ revoked: true });
  });

  routes.post("/:name/grants", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    if (!agentId) {
      return context.json({ error: "The Bot is required." }, 400);
    }

    try {
      await store.grant(name, agentId);
    } catch (error) {
      if (error instanceof ComponentNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }

    await audit(context, "component.granted", name, { bot: agentId });
    return context.json({ granted: true });
  });

  routes.delete("/:name/grants/:agentId", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const name = context.req.param("name");
    const agentId = context.req.param("agentId");
    try {
      await store.revoke(name, agentId, context.var.actor.email);
    } catch (error) {
      if (error instanceof ComponentNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
    await audit(context, "component.revoked", name, { bot: agentId });
    return context.json({ revoked: true });
  });

  routes.post("/:name/publication", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      published?: unknown;
    } | null;
    const published = body?.published !== false;

    try {
      if (published) {
        await store.publish(name, context.var.actor.email);
      } else {
        await store.unpublish(name, context.var.actor.email);
      }
    } catch (error) {
      if (error instanceof ComponentNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }

    await audit(
      context,
      published ? "component.published" : "component.unpublished",
      name,
      {},
    );
    return context.json({ published });
  });

  /**
   * Edit the draft. Changes nothing a model can see until it is published, which is the point of
   * having a draft at all.
   */
  routes.put("/:name/draft", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const name = context.req.param("name");
    const body = (await context.req.json().catch(() => null)) as {
      description?: unknown;
    } | null;
    const description =
      typeof body?.description === "string" ? body.description.trim() : "";
    if (!description) {
      return context.json({ error: "A description is required." }, 400);
    }

    try {
      await store.saveDraft(name, description, context.var.actor.email);
    } catch (error) {
      if (error instanceof ComponentNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }

    await audit(context, "component.draft_saved", name, {});
    return context.json({ saved: true });
  });

  return routes;
}
