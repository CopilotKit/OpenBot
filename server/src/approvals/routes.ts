import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { ApprovalService } from "./service";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
  RULE_BEHAVIOURS,
} from "./types";

const pattern = z.string().trim().min(1).max(300);
/** An action class: which Bot, which tool or app, which kind of effect, and which target. */
const ruleInput = z.strictObject({
  botId: pattern.default("*"),
  toolRef: pattern,
  effect: pattern.default("*"),
  scope: pattern.default("*"),
  behaviour: z.enum(RULE_BEHAVIOURS),
});
const hostCommands = z.enum(["ask", "allow", "never"]);
/** A change to a saved rule: any of its fields, and at least one. */
const ruleChange = z
  .strictObject({
    botId: pattern,
    toolRef: pattern,
    effect: pattern,
    scope: pattern,
    behaviour: z.enum(RULE_BEHAVIOURS),
  })
  .partial()
  .refine(
    (input) => Object.keys(input).length > 0,
    "Change at least one field.",
  );

import { HeadlessToolSuspension } from "../computer/headless-tools";

export function createApprovalRoutes(
  service: ApprovalService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) =>
    // A body that is not JSON is the caller's mistake, as the delivery routes answer it, not a
    // 500 carrying the parser's message.
    error instanceof SyntaxError
      ? context.json({ error: "Supply a valid request." }, 400)
      : context.json(
          { error: error.message },
          error instanceof ApprovalNotFoundError
            ? 404
            : error instanceof ApprovalRefusedError ||
                error instanceof z.ZodError
              ? 400
              : 500,
        ),
  );
  routes.get("/", async (context) =>
    context.json(await service.inbox(context.var.actor.id)),
  );
  routes.post("/computer/:botId", async (context) => {
    try {
      return context.json({
        result: await service.frontendAction(
          context.var.actor.id,
          context.req.param("botId"),
          await context.req.json(),
        ),
      });
    } catch (error) {
      if (error instanceof HeadlessToolSuspension)
        return context.json(
          {
            waiting: true,
            approvalId: error.waiting.requestId,
            reason: error.message,
          },
          202,
        );
      throw error;
    }
  });
  routes.patch("/preferences", async (context) => {
    const input = z
      .strictObject({
        enabled: z.boolean().optional(),
        autoReview: z.boolean().optional(),
        hostCommands: hostCommands.optional(),
      })
      .parse(await context.req.json());
    if (!service.store.policy) {
      if (input.enabled === undefined)
        throw new ApprovalRefusedError("Choose whether to ask first.");
      await service.store.setEnabled(context.var.actor.id, input.enabled);
      return context.json({ enabled: input.enabled });
    }
    return context.json(
      await service.setPreferences(context.var.actor.id, input),
    );
  });
  routes.post("/rules", async (context) =>
    context.json(
      {
        rule: await service.createRule(
          context.var.actor.id,
          ruleInput.parse(await context.req.json()),
        ),
      },
      201,
    ),
  );
  routes.patch("/rules/:id", async (context) =>
    context.json({
      rule: await service.updateRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await context.req.json()),
      ),
    }),
  );
  /** Team rules and settings. Members read them as locked rows in the inbox; only admins change them. */
  routes.patch("/team", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const input = z
      .strictObject({
        enforceAutoReview: z.boolean().optional(),
        customRulesEnabled: z.boolean().optional(),
        hostCommandsCap: hostCommands.optional(),
      })
      .parse(await context.req.json());
    return context.json(
      await service.setTeamSettings(context.var.actor.id, input),
    );
  });
  routes.post("/team/rules", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(
      {
        rule: await service.createTeamRule(
          context.var.actor.id,
          ruleInput.parse(await context.req.json()),
        ),
      },
      201,
    );
  });
  routes.patch("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({
      rule: await service.updateTeamRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await context.req.json()),
      ),
    });
  });
  routes.delete("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await service.revokeTeamRule(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  routes.post("/questions/:id/respond", async (context) => {
    const input = z
      .strictObject({ response: z.string().trim().min(1).max(6000) })
      .parse(await context.req.json());
    return context.json(
      await service.answerQuestion(
        context.var.actor.id,
        context.req.param("id"),
        input.response,
      ),
    );
  });
  routes.post("/:id/decision", async (context) => {
    const input = z
      .strictObject({
        decision: z.enum(["allow_once", "allow_always", "deny", "handled"]),
      })
      .parse(await context.req.json());
    const request = await service.decide(
      context.var.actor.id,
      context.req.param("id"),
      input.decision,
    );
    return context.json({ id: request.id, status: request.status });
  });
  routes.delete("/rules/:id", async (context) => {
    await service.revoke(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  return routes;
}
