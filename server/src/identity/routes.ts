import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { PROVIDERS } from "./providers";
import type { IdentityStore } from "./store";

/**
 * A person's own linked accounts.
 *
 * Every route is the asker's own: there is no administrator view of somebody else's links and no
 * way to link an account on another person's behalf. What leaves here is what the settings page
 * draws; realm, subject and credential stay on the server.
 */
export function identityRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store?: Pick<IdentityStore, "identitiesFor" | "unlink">,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  if (!store) {
    app.all("*", (context) =>
      context.json({ error: "Linked accounts are not available." }, 503),
    );
    return app;
  }
  const live = store;

  app.get("/links", async (context) => {
    const links = await live.identitiesFor(context.var.actor.id);
    return context.json({
      links: links.map((link) => ({
        id: link.id,
        provider: link.provider,
        title: PROVIDERS[link.provider].title,
        handle: link.handle,
        status: link.status,
        createdAt: link.createdAt.toISOString(),
      })),
    });
  });

  app.delete("/links/:id", async (context) => {
    const removed = await live.unlink(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!removed)
      return context.json({ error: "Linked account not found." }, 404);
    return context.body(null, 204);
  });

  return app;
}
