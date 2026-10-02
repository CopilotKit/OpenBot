import { Hono, type MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import type { ActionActor } from "../computer/gateway";
import type { SignInService } from "./service";
import { SignInRefusedError } from "./types";

/** Same rule as the computer routes: the local development actor is not a users row. */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

function actorOf(context: { var: AppVariables }): ActionActor {
  const record = context.var.actor;
  return {
    id: record.id,
    ...(record.email === DEV_ACTOR_EMAIL ? {} : { userId: record.id }),
    initiator: { kind: "person" },
  };
}

/** A body field that must be a short string, read without echoing it into an error. */
function field(
  body: Record<string, unknown> | null,
  name: string,
  { required = false, max = 4096 } = {},
): string | undefined {
  const value = body?.[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new SignInRefusedError(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > max)
    throw new SignInRefusedError(
      `${name} must be text of at most ${max} characters.`,
    );
  return value;
}

async function readBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * The private sign-in form's API, and the Passwords list.
 *
 * Mounted at `/api/sign-in-requests` and `/api/passwords`. Every route is the signed-in owner's own:
 * the store is scoped by owner, so another person's request id answers 404.
 *
 * THE ERROR HANDLER NEVER RELAYS AN UNEXPECTED MESSAGE. A body on these routes carries a password,
 * and an error this module did not write (a database driver's, say) can quote the statement it was
 * running. Refusals are this module's own sentences; everything else is one fixed line.
 */
export function createSignInRoutes(
  service: SignInService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canUseBot: BotAccessCheck,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof SignInRefusedError)
      return context.json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({ type: "sign-in-route-error", name: error.name }),
    );
    return context.json({ error: "The sign-in could not be completed." }, 500);
  });

  /** The open chat's Bot asking. An unattended Bot asks through its headless tool instead. */
  routes.post("/", async (context) => {
    const body = await readBody(context.req.raw);
    const botId = field(body, "botId", { required: true, max: 200 }) as string;
    if (!(await canUseBot(context.var.actor, botId)))
      throw new SignInRefusedError("There is no such Bot.", 404);
    const request = await service.request({
      ownerUserId: context.var.actor.id,
      botId,
      site: field(body, "site", { required: true, max: 2048 }) as string,
      reason: field(body, "reason", { max: 500 }),
      actor: actorOf(context),
      threadId: field(body, "threadId", { max: 200 }),
      toolCallId: field(body, "toolCallId", { max: 200 }),
    });
    return context.json(
      await service.get(context.var.actor.id, request.id),
      201,
    );
  });

  routes.get("/", async (context) =>
    context.json({ requests: await service.pending(context.var.actor.id) }),
  );

  routes.get("/:id", async (context) =>
    context.json(
      await service.get(context.var.actor.id, context.req.param("id")),
    ),
  );

  routes.post("/:id/submit", async (context) => {
    const body = await readBody(context.req.raw);
    return context.json(
      await service.submit(
        context.var.actor.id,
        context.req.param("id"),
        actorOf(context),
        {
          username: field(body, "username", { max: 512 }),
          password: field(body, "password", { required: true }) as string,
          code: field(body, "code", { max: 64 }),
          save: body?.save === true,
        },
      ),
    );
  });

  routes.post("/:id/use-saved", async (context) => {
    const body = await readBody(context.req.raw);
    return context.json(
      await service.useSaved(
        context.var.actor.id,
        context.req.param("id"),
        actorOf(context),
        {
          loginId: field(body, "loginId", {
            required: true,
            max: 200,
          }) as string,
          code: field(body, "code", { max: 64 }),
        },
      ),
    );
  });

  routes.post("/:id/take-over", async (context) =>
    context.json(
      await service.takeOver(
        context.var.actor.id,
        context.req.param("id"),
        actorOf(context),
      ),
    ),
  );

  routes.post("/:id/finish", async (context) =>
    context.json(
      await service.finishTakeover(
        context.var.actor.id,
        context.req.param("id"),
        actorOf(context),
      ),
    ),
  );

  routes.post("/:id/cancel", async (context) =>
    context.json(
      await service.cancel(
        context.var.actor.id,
        context.req.param("id"),
        actorOf(context),
      ),
    ),
  );

  return routes;
}

export function createPasswordRoutes(
  service: SignInService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof SignInRefusedError)
      return context.json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({ type: "passwords-route-error", name: error.name }),
    );
    return context.json({ error: "Your passwords could not be read." }, 500);
  });
  routes.get("/", async (context) =>
    context.json(await service.logins(context.var.actor.id)),
  );
  routes.delete("/:id", async (context) =>
    context.json(
      await service.deleteLogin(
        context.var.actor.id,
        context.req.param("id"),
        actorOf(context),
      ),
    ),
  );
  return routes;
}
