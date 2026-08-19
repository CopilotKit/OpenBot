/**
 * Where a person answers the questions a boundary raised, wherever it raised them.
 *
 * Its own surface rather than a pair of handlers under the computer, because the computer is not the
 * only thing the action policy judges. The same rules decide a Bot's calls to somebody else's
 * servers, an `ask` rule written about those is the shape operators reach for first, "ask me before
 * anything changes anything in Jira", and a deployment that runs plugins without a browser would
 * otherwise raise questions on a surface it never mounted: the Bot would sit for the full ten
 * minutes and then report that nobody answered, having never asked anybody.
 *
 * Answering is a person acting, so it is audited as one, under their own actor and against the thing
 * the question was about rather than against whatever endpoint they happened to press the button on.
 * The row is written here, next to the answer, because these two handlers are the only place in the
 * product where consent is recorded and a second place would eventually record it differently.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  type ApprovalRegistry,
  type PendingApproval,
  presentable,
} from "./approvals";

/**
 * The local actor's address, matched to decide whether the id is a real users row.
 *
 * Compared against rather than imported from `auth/dev-actor` because this must not depend on the
 * authentication module's internals; this is the one fact about it that matters here.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

export function createApprovalRoutes(
  approvals: ApprovalRegistry,
  auditStore: AuditStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The questions this Bot is waiting on, for the surface to poll.
   *
   * A read, so no audit row, exactly like asking who holds the wheel. The interesting rows are the
   * one written when the question was raised and the one written when somebody answered it.
   */
  routes.get("/:botId", requireUser, (context) =>
    context.json({
      approvals: approvals
        .pending(context.req.param("botId") ?? "")
        .map(presentable),
    }),
  );

  routes.post("/:botId/:approvalId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    // Said explicitly, never defaulted. A body that forgot to say which way it went must not be
    // read as an approval, and reading a missing field as a refusal would be equally wrong.
    if (typeof body?.granted !== "boolean") {
      return context.json(
        { error: "Say whether this is allowed or not." },
        400,
      );
    }

    const botId = context.req.param("botId") ?? "";
    const record = context.var.actor;
    const answered = approvals.answer(
      context.req.param("approvalId") ?? "",
      botId,
      record.id,
      body.granted,
    );
    // Nothing is broken and there is nothing to fix: the question expired, or somebody else answered
    // it, most likely in another tab. A conflict rather than a fault.
    if (!answered.ok) {
      return context.json(
        {
          error:
            "That request is no longer waiting for an answer. It may have expired, or somebody else answered it.",
        },
        409,
      );
    }

    await recordAuditEvent(auditStore, {
      eventType: body.granted ? "approval.granted" : "approval.denied",
      targetType: answered.approval.target.type,
      targetId: answered.approval.target.id,
      // Only a real users row may go in the audit table's foreign key column. The local development
      // actor is not one, so writing it there fails the constraint and loses the row entirely. Who
      // it was is recorded in the payload regardless.
      ...(record.email === DEV_ACTOR_EMAIL ? {} : { actorUserId: record.id }),
      payload: payloadFor(answered.approval, record.id),
    });

    // Projected, like the list above. What the surface does with an answer is stop showing the
    // question, and nothing it needs for that is worth sending the binding out of this process for.
    return context.json(presentable(answered.approval));
  });

  return routes;
}

/**
 * What an answer records: the question, the boundary that raised it, and who answered.
 *
 * The Bot whose turn met the rule comes off the approval rather than out of the request, so the row
 * says which Bot it was actually about even if somebody arrives at the wrong address with a real id.
 */
function payloadFor(approval: PendingApproval, answeredBy: string) {
  return {
    bot: approval.botId,
    actor: answeredBy,
    approval: approval.id,
    rule: approval.rule,
    // The question as a person read it, so the trail records what they were shown rather than a
    // reconstruction of it.
    reason: approval.question,
    // Who was driving when the boundary stopped, which is usually not who answered. The gap between
    // the two is the reason this is its own row.
    asked: approval.actor,
  };
}
