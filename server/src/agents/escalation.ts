/**
 * Asking a person, as a first-class answer.
 *
 * A Bot that needs judgement has three things it can do: guess, ask another Bot, or ask the person.
 * Only the first two were ever offered, and a model with no named way to stop will take one of them:
 * it guesses confidently, or it hands the work sideways to a Bot that cannot settle it either and
 * spends a run finding that out. The caps in `handoff.ts` then become the only exit from a chain
 * that should never have started.
 *
 * So this is a tool, sitting beside the one for handing work to another Bot and competing with it
 * for the same decision. It ends the Bot's turn by putting the question to whoever this deployment
 * says stands behind the work, and it says who that was, so the Bot can tell the person what it has
 * done rather than falling silent.
 *
 * WHO "A PERSON" IS, IS A SEAM. In this template it is the person in the conversation, which is the
 * only answer a template can give honestly. A company running this has a different one: an on-call
 * rota, a duty desk, a queue somebody works through in the morning. That is a route this deployment
 * hands in, not a channel post written into the tool.
 */

import { z } from "zod";
import { PUT_TO } from "../../../shared/handoff-markers";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { GrantedTool } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";

/** What the model is offered. One name, so a transcript can find every escalation by searching. */
export const ESCALATE_TOOL = "ask_person";

/**
 * Where a question for a person goes.
 *
 * Returns who was reached, in words a Bot can say out loud: "the person in this conversation", "the
 * on-call engineer". It is the sentence the model repeats, so it is written for the person reading
 * the transcript rather than for a log.
 *
 * A route that cannot reach anybody should say so rather than throw. A Bot mid-run with a person
 * waiting gets nothing from an exception: the run ends with nothing said, which reads as the Bot
 * ignoring them.
 */
export type EscalationRoute = (input: {
  actorId: string;
  botId: string;
  threadId?: string;
  runId: string;
  question: string;
  why?: string;
}) => Promise<{ reached: string } | { refusal: string }>;

/**
 * The route this template ships with: the person who is already here.
 *
 * It sends nothing anywhere, and that is the whole point. The Bot is in a conversation with the
 * person who asked; the honest thing is for it to put the question to them in its own next sentence,
 * which is a thing it can already do and was not doing. What this adds is that the model now has a
 * named way to choose it, and that the choice is on the record.
 */
export const askTheirOwnPerson: EscalationRoute = async () => ({
  reached: "the person in this conversation",
});

const parameters = z.object({
  question: z
    .string()
    .describe("The question you need a person to answer, in one sentence"),
  why: z
    .string()
    .optional()
    .describe(
      "Why this needs a person rather than you: what you cannot settle on your own",
    ),
});

/**
 * The tool, for any run at all.
 *
 * NOT GATED ON A GRANT, unlike handing work to another Bot. Reaching a second Bot spends a model
 * call, may wake a computer and can fan out; asking the person who is already in the conversation
 * costs nothing and cannot be aimed anywhere they cannot see. Making it a grant would mean a
 * deployment could switch off the safe exit and leave the expensive one, which is backwards.
 */
export function escalationTool(options: {
  /** The run doing the asking, as this deployment signed it. */
  from: RunAssertion;
  route: EscalationRoute;
  auditStore?: AuditStore;
}): GrantedTool {
  const { from, route, auditStore } = options;

  return {
    name: ESCALATE_TOOL,
    ref: `bot/${ESCALATE_TOOL}`,
    description:
      "Put a question to a person when the work needs judgement you do not have: a decision only " +
      "they can make, a fact only they know, permission you do not hold. Prefer this to guessing, " +
      "and prefer it to asking another Bot when no other Bot could settle it either. Say what you " +
      "need and why, then stop and wait for their answer.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        return "That was not put to anybody: say what you need a person to answer.";
      }

      const outcome = await route({
        actorId: from.actorId,
        botId: from.botId,
        ...(from.threadId ? { threadId: from.threadId } : {}),
        runId: from.runId,
        question: parsed.data.question,
        ...(parsed.data.why ? { why: parsed.data.why } : {}),
      });

      /*
       * Recorded either way. An escalation that could not be delivered is the one worth finding
       * later: the Bot stopped, the person was never asked, and without a row nothing says so.
       */
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType:
            "reached" in outcome
              ? "agent.escalated"
              : "agent.escalation_failed",
          targetType: "agent",
          targetId: from.botId,
          ...(from.actorId ? { actorUserId: from.actorId } : {}),
          payload: {
            bot: from.botId,
            run: from.runId,
            question: parsed.data.question,
            ...(parsed.data.why ? { why: parsed.data.why } : {}),
            ...("reached" in outcome
              ? { reached: outcome.reached }
              : { reason: outcome.refusal }),
          },
        });
      }

      return "reached" in outcome
        ? `${PUT_TO}${outcome.reached}. Ask it in your own words now, plainly, and stop there: do not answer it yourself and do not hand it to another Bot.`
        : outcome.refusal;
    },
  };
}

/** Re-exported so callers of this module do not need to know where it is declared. */
export { PUT_TO };
