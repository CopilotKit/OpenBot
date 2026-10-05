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
      slug?: unknown;
      title?: unknown;
      description?: unknown;
      html?: unknown;
      css?: unknown;
      jsFunctions?: unknown;
      argumentSchema?: unknown;
      sampleArguments?: unknown;
    } | null;

    if (
      typeof body?.slug !== "string" ||
      !body.slug.trim() ||
      typeof body?.title !== "string" ||
      !body.title.trim()
    ) {
      return context.json({ error: "A name and a title are required." }, 400);
    }

    /*
     * Every other field is optional, but none of them is untyped. This used to pass
     * `body.description ?? ""` straight into `store.save`, so `{"description": 123}` or
     * `{"argumentSchema": "not-an-object"}` travelled into a text/jsonb column and came
     * back as an unhandled 500 from the database. Absent still means the default; a
     * present value must be its type, else 400 naming the field.
     */
    for (const field of [
      "description",
      "html",
      "css",
      "jsFunctions",
    ] as const) {
      const value = body[field];
      if (value !== undefined && typeof value !== "string") {
        return context.json(
          { error: `The component ${field} must be text.` },
          400,
        );
      }
    }
    for (const field of ["argumentSchema", "sampleArguments"] as const) {
      const value = body[field];
      if (
        value !== undefined &&
        (!value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.getPrototypeOf(value) !== Object.prototype)
      ) {
        return context.json(
          { error: `The component ${field} must be an object.` },
          400,
        );
      }
    }

    const slug = body.slug as string;
    const title = body.title as string;
    const description =
      body.description === undefined ? "" : (body.description as string);
    const html = body.html === undefined ? "" : (body.html as string);
    const css = body.css === undefined ? "" : (body.css as string);
    const jsFunctions =
      body.jsFunctions === undefined ? "" : (body.jsFunctions as string);
    const argumentSchema =
      body.argumentSchema === undefined
        ? {}
        : (body.argumentSchema as Record<string, unknown>);
    const sampleArguments =
      body.sampleArguments === undefined
        ? {}
        : (body.sampleArguments as Record<string, unknown>);

    try {
      const component = await store.save({
        slug: slug.trim(),
        title: title.trim(),
        description,
        html,
        css,
        jsFunctions,
        argumentSchema,
        sampleArguments,
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

    // Answered like `publish`, because it is the same question: this surface owns the components it
    // authored, and a name with no draft behind it is not one of them. Reporting that as "not found"
    // rather than as success also stops a caller reading `{ ok: true }` as "the thing you named is
    // gone", which it was not.
    try {
      await store.remove(context.req.param("name"), actorEmail(context));
      return context.json({ ok: true });
    } catch (error) {
      if (error instanceof SandboxedNotFoundError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  return routes;
}
