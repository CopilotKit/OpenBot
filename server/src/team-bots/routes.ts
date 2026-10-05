import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import {
  TeamBotForbiddenError,
  TeamBotNotFoundError,
  TeamBotRefusedError,
  type TeamBots,
} from "./team-bots";

export function createTeamBotRoutes(
  teamBots: TeamBots,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) =>
    context.json(
      { error: error.message },
      error instanceof TeamBotForbiddenError
        ? 403
        : error instanceof TeamBotNotFoundError
          ? 404
          : error instanceof TeamBotRefusedError || error instanceof z.ZodError
            ? 400
            : 500,
    ),
  );
  routes.get("/", async (context) =>
    context.json({
      teamBots: await teamBots.list(context.var.actor),
      publishable: await teamBots.publishable(context.var.actor),
    }),
  );
  routes.delete("/consents", async (context) => {
    await teamBots.clearConsents(context.var.actor);
    return context.body(null, 204);
  });
  routes.put("/:botId/publication", async (context) => {
    const input = z
      .strictObject({
        audience: z.enum(["team", "people"]),
        emails: z.array(z.string().max(320)).max(200).default([]),
        groups: z.array(z.string().max(200)).max(100).default([]),
      })
      .parse(await context.req.json());
    await teamBots.publish(
      context.var.actor,
      context.req.param("botId"),
      input,
    );
    return context.body(null, 204);
  });
  routes.delete("/:botId/publication", async (context) => {
    await teamBots.unpublish(context.var.actor, context.req.param("botId"));
    return context.body(null, 204);
  });
  routes.post("/:botId/assignments", async (context) => {
    const input = z
      .strictObject({ group: z.string().min(1).max(200) })
      .parse(await context.req.json());
    await teamBots.assign(
      context.var.actor,
      context.req.param("botId"),
      input.group,
    );
    return context.body(null, 204);
  });
  routes.delete("/:botId/assignments/:group", async (context) => {
    await teamBots.unassign(
      context.var.actor,
      context.req.param("botId"),
      decodeURIComponent(context.req.param("group")),
    );
    return context.body(null, 204);
  });
  routes.post("/:botId/consents", async (context) => {
    const input = z
      .strictObject({
        serverId: z.string().min(1).max(200),
        decision: z.enum([
          "allow_once",
          "allow_always",
          "allow_all_team_bots",
          "skip",
        ]),
      })
      .parse(await context.req.json());
    await teamBots.consent(
      context.var.actor,
      context.req.param("botId"),
      input.serverId,
      input.decision,
    );
    return context.body(null, 204);
  });
  return routes;
}
