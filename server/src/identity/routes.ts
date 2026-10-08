import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { PROVIDERS } from "./providers";
import type { IdentityStore } from "./store";
import { IdentityLinkError } from "./types";

const tokenBody = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/**
 * A person's own linked accounts, and the browser half of a chat-started link.
 *
 * Every route is the asker's own: there is no administrator view of somebody else's links and no
 * way to link an account on another person's behalf. What leaves here is what the settings page
 * draws; realm, subject and credential stay on the server.
 */
export function identityRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store?: Pick<
    IdentityStore,
    "identitiesFor" | "unlink" | "peekChallenge" | "confirmChallenge"
  >,
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

  app.post("/challenges/peek", async (context) => {
    const parsed = tokenBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return context.json({ error: "Invalid link." }, 400);
    const challenge = await live.peekChallenge(parsed.data.token);
    if (!challenge)
      return context.json(
        { error: "This link expired or was already used. Ask for a new one." },
        404,
      );
    return context.json({
      challenge: {
        provider: challenge.provider,
        title: PROVIDERS[challenge.provider].title,
        handle: challenge.handle,
      },
    });
  });

  app.post("/challenges/confirm", async (context) => {
    const parsed = tokenBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return context.json({ error: "Invalid link." }, 400);
    const challenge = await live.peekChallenge(parsed.data.token);
    try {
      await live.confirmChallenge(parsed.data.token, context.var.actor.id);
    } catch (error) {
      if (!(error instanceof IdentityLinkError)) throw error;
      return context.json(
        {
          error:
            "This link expired, was already used, or was confirmed by a different account. Ask for a new one.",
        },
        409,
      );
    }
    const hint = challenge
      ? (PROVIDERS[challenge.provider].completionHint?.(parsed.data.token) ??
        null)
      : null;
    return context.json({ confirmation: { hint } });
  });

  return app;
}
