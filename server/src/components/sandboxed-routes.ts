import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  SandboxedNameRefusedError,
  SandboxedNotFoundError,
  type SandboxedStore,
} from "./sandboxed";

/**
 * The playground's endpoints, and the one the app renders from.
 *
 * Mounted apart from `/api/components` rather than inside it. Those routes end in `/:name/...`, so a
 * `/sandboxed` path would sit one registration-order mistake away from being swallowed by the
 * parameter route, and the failure would look like a component called "sandboxed". A separate mount
 * cannot be shadowed by accident.
 *
 * Governance still lives next door. Granting, publishing a description and asking whether a Bot
 * may use one of these all go through the component routes unchanged, because a sandboxed component
 * writes a `components` row like any other. What is here is only what is different: the source.
 */
export function createSandboxedRoutes(
  store: SandboxedStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  /** Everything the playground edits. Admin-only: this is the source of what Bots draw. */
  routes.get("/", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    return context.json({ components: await store.list() });
  });

  /**
   * The published source, for the app to render from.
   *
   * Open to any signed-in person, unlike the list above. This is what a Bot draws with in a
   * conversation the person is already in; the draft is an administrator's working copy and is not
   * theirs to read.
   */
  routes.get("/published", requireUser, async (context) =>
    context.json({ components: await store.published() }),
  );

  routes.post("/", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      slug?: string;
      title?: string;
      description?: string;
      html?: string;
      css?: string;
      jsFunctions?: string;
      argumentSchema?: Record<string, unknown>;
      sampleArguments?: Record<string, unknown>;
    } | null;

    if (!body?.slug || !body.title) {
      return context.json({ error: "A name and a title are required." }, 400);
    }

    try {
      const component = await store.save({
        slug: body.slug,
        title: body.title,
        description: body.description ?? "",
        html: body.html ?? "",
        css: body.css ?? "",
        jsFunctions: body.jsFunctions ?? "",
        argumentSchema: body.argumentSchema ?? {},
        sampleArguments: body.sampleArguments ?? {},
        by: actorEmail(context),
      });
      return context.json({ component });
    } catch (error) {
      if (error instanceof SandboxedNameRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.post("/:name/publish", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    try {
      const component = await store.publish(
        context.req.param("name"),
        actorEmail(context),
      );
      return context.json({ component });
    } catch (error) {
      if (error instanceof SandboxedNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  routes.delete("/:name", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    await store.remove(context.req.param("name"), actorEmail(context));
    return context.json({ ok: true });
  });

  return routes;
}
