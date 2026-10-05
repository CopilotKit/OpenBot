import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "./auth/guards";
import type { UserPreferencesStore } from "./user-preferences";

/*
 * Each preference is optional so one control can save its own without restating the others, and
 * the merge in Postgres keeps the rest. Strict, so an unknown key is refused rather than stored, and
 * at least one key, so an empty body is a mistake rather than a no-op write.
 */
const preferencesPatch = z
  .strictObject({
    messageListEmphasis: z.enum(["agent", "thread"]).optional(),
    selfHostBannerDismissed: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export function userPreferencesRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store?: UserPreferencesStore,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.get("/", async (context) => {
    if (!store)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    return context.json({
      preferences: await store.read(context.var.actor.id),
    });
  });
  app.patch("/", async (context) => {
    if (!store)
      return context.json(
        { error: "User preferences are not available." },
        503,
      );
    const parsed = preferencesPatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        {
          error:
            "Choose agent or thread for message list emphasis, or true or false for the self-host banner.",
        },
        400,
      );
    }
    return context.json({
      preferences: await store.patch(context.var.actor.id, parsed.data),
    });
  });
  return app;
}
