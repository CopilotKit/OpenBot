import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { installedMailService, MailRefusedError } from "./service";

/**
 * A person's own mailbox: see it (never the password), save it, take it away. Scoped to the signed-in
 * person; there is no way to read or set anybody else's.
 */
export function createMailRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof MailRefusedError)
      return context.json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({ type: "mail-route-error", name: error.name }),
    );
    return context.json(
      { error: "Your email settings could not be read." },
      500,
    );
  });
  routes.use("*", async (context, next) => {
    if (!installedMailService()) {
      return context.json(
        { error: "Email is not available on this server." },
        503,
      );
    }
    await next();
  });

  routes.get("/account", async (context) =>
    context.json({
      account: await installedMailService()?.account(context.var.actor.id),
    }),
  );
  routes.put("/account", async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const text = (key: string) =>
      typeof body?.[key] === "string" ? (body[key] as string) : undefined;
    const account = await installedMailService()?.save(context.var.actor.id, {
      address: text("address") ?? "",
      password: text("password") ?? "",
      username: text("username"),
      imapHost: text("imapHost"),
      smtpHost: text("smtpHost"),
    });
    return context.json({ account });
  });
  routes.delete("/account", async (context) =>
    context.json(
      (await installedMailService()?.remove(context.var.actor.id)) ?? {
        removed: false,
      },
    ),
  );
  return routes;
}
