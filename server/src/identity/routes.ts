import { Hono, type MiddlewareHandler } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { PROVIDERS } from "./providers";
import type { IdentityStore } from "./store";

export type IdentityRouteOptions = {
  slackLinking?: boolean;
  github?: { clientId: string; publicUrl: string; encryptionKey: string };
};

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
  auditStore?: AuditStore,
  options: IdentityRouteOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  if (!store) {
    /*
     * The code is what tells the settings page "this deployment has no identity store" apart from a
     * proxy or platform 503, which must surface as an error rather than hide the section.
     */
    app.all("*", (context) =>
      context.json(
        {
          error: "Linked accounts are not available.",
          code: "identity_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  const live = store;

  app.get("/providers", (context) =>
    context.json({
      providers: {
        slack: Boolean(options.slackLinking),
        github: Boolean(options.github),
      },
    }),
  );

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
    const actorId = context.var.actor.id;
    const id = context.req.param("id");
    const removed = await live.unlink(actorId, id);
    /*
     * The code is what tells the settings page "this link is already gone" apart from a proxy,
     * missing-route or SPA-fallback 404, which must surface as a failed disconnect.
     */
    if (!removed)
      return context.json(
        { error: "Linked account not found.", code: "identity_link_not_found" },
        404,
      );
    /*
     * After the removal, and not caught: the same order and the same failure as the connected-account
     * disconnect (`mcp.account_disconnected`), where an audit write that throws fails the request.
     * The audit is written after the unlink commits, so such a failure leaves the link already gone
     * and the request failed; a retry answers 404 and writes no audit row.
     *
     * Names the link and its provider only. The subject, realm and credential id stay out of the
     * trail, as they stay out of every response here.
     */
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "identity.unlinked",
        targetType: "identity_link",
        targetId: id,
        actorUserId: actorId,
        payload: { actor: actorId, provider: removed.provider },
      });
    }
    return context.body(null, 204);
  });

  return app;
}
