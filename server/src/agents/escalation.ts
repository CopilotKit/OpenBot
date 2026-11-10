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

import { PUT_TO } from "@openbot/shared/handoff-markers";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
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
  /** Preserved for a durable question routed from an unattended routine or delegated run. */
  initiator?: AuditInitiator;
  question: string;
  why?: string;
  /** The decisions inside the question, one or several, when the Bot sent them as parts. */
  parts?: QuestionPart[];
}) => Promise<{ reached: string } | { refusal: string }>;

/**
 * One decision inside a question, with the answers the Bot expects when it can name them. The person
 * can always answer in their own words instead, so `options` are a shortcut, never a limit.
 *
 * NO LOWER BOUND ON `options`. It used to take two at least, and a free-text decision (which city,
 * what name) has no likely answers to name: models send it with `options: []`, which that bound
 * refused before anybody was asked, so the first-use "Find weekend plans" starter drew its city
 * question as Blocked. An empty list is the same question as one with no list, and `freeText` below
 * drops it before the question travels. One option is kept: it is a suggestion the person can take
 * with one click or answer past, and refusing it would leave the person unasked over a hint.
 */
export const questionPartSchema = z.object({
  header: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe("A short label for this decision, two or three words"),
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("This one decision, as a question"),
  options: z
    .array(z.string().trim().min(1).max(120))
    .max(6)
    .optional()
    .describe(
      "Optional. The likely answers, when you can name them. Leave this out for an answer the " +
        "person types, such as a city, a name or a date",
    ),
});
export type QuestionPart = z.infer<typeof questionPartSchema>;

/** A decision with an empty `options` list is a free-text one: it travels without the list. */
function freeText(part: QuestionPart): QuestionPart {
  if (part.options?.length) return part;
  const { options: _none, ...rest } = part;
  return rest;
}

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
  /*
   * One part is a question too.
   *
   * This took two to six, written for the case it was added for: several decisions that used to
   * arrive numbered inside one sentence. A single decision with the answers the Bot expects (which
   * time zone, and the three it thinks likely) is the same shape with one entry, and models send it
   * that way. Refused, the person was never asked, the chat drew the step as Blocked, and the Bot
   * went on to guess, which is the one thing this tool is for stopping.
   */
  parts: z
    .array(questionPartSchema)
    .min(1)
    .max(6)
    .optional()
    .describe(
      "The decisions you need, one entry per decision, with `options` when you can name the " +
        "likely answers. A single decision is one entry. With several, `question` sums them up " +
        "in a sentence",
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
    /*
     * The closed test the prompt's asking section gives, in the same words. This used to say
     * "Prefer this to guessing" and was offered on every run, which pulled a routine with nobody
     * watching toward questions instead of a delivered answer with its assumptions said.
     */
    description:
      "Put a question to a person only when you cannot go on without them: a wrong guess would " +
      "send, delete, pay or do something else hard to undo; the possible readings would lead to " +
      "materially different work; or only they know the answer. Otherwise make the call, say what " +
      "you assumed, and keep going. Do everything that does not depend on the answer before you " +
      "ask. Prefer it to asking another Bot when no other Bot could settle it either. Say what you " +
      "need and why, then stop and wait for their answer. Put each decision in `parts`, one " +
      "entry each: one decision is a single entry, and several are separate entries rather than " +
      "numbered inside one sentence. `options` is optional: give it when you can name the likely " +
      "answers, and leave it out when the person types the answer, such as a city, a name or a date.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        return "That was not put to anybody: say what you need a person to answer.";
      }

      /*
       * A question field that is present and empty is a call with nothing in it.
       *
       * `z.string()` accepts "" and a run of spaces, so the refusal above — which is the sentence
       * written for exactly this — only ever fired when the field was missing altogether. Spelled
       * the other way it went straight through: the Bot was told its question had been put to
       * somebody, the turn ended on that, and the trail took an `agent.escalated` row with nothing
       * in its question, which is the row an operator counts escalations by. Where a route is a duty
       * desk rather than the person already here, it is a page to somebody with no question on it.
       *
       * `message_bot`, which this competes with for the same decision, refuses a blank task and says
       * so. This is the other half of that, and the trimmed text is what travels, for the same
       * reason a handoff sends the trimmed task: what was recorded should be what was asked.
       */
      const question = parsed.data.question.trim();
      if (!question) {
        return "That was not put to anybody: say what you need a person to answer.";
      }

      /*
       * A route that throws is a route that refused, and the run has to survive it.
       *
       * `handoff.ts` says the rule for both of these tools at the top of its module: every refusal is
       * an answer, not an error, because the asking Bot is mid-run with a person waiting and a thrown
       * error ends the run with nothing said. This tool competes with that one for the same decision
       * and did not follow it — the throw came straight back out of `execute`, which is the failure
       * that reads to the person as the Bot ignoring them, on the tool whose entire job is to stop
       * ignoring them.
       *
       * It looks unreachable and is not. `askTheirOwnPerson` is a pure function that cannot throw, so
       * nothing in this repo or its tests ever takes this path — but the module comment above says
       * WHO "A PERSON" IS, IS A SEAM, and every route a company actually hands in is a duty desk, a
       * rota, a queue: a network call that times out, 502s, or resolves DNS to nothing. The one route
       * that cannot fail is the one that ships, so the guard was missing exactly where the
       * documentation invites a deployment to go.
       *
       * Recorded as `agent.escalation_failed`, which is what the comment below already promises for
       * an escalation that could not be delivered and previously only delivered for a route polite
       * enough to return its refusal.
       */
      /** What the route threw, if it did, for the row and never for the answer. */
      let thrown: string | undefined;
      let outcome: { reached: string } | { refusal: string };
      try {
        outcome = await route({
          actorId: from.actorId,
          botId: from.botId,
          ...(from.threadId ? { threadId: from.threadId } : {}),
          runId: from.runId,
          ...(from.initiator ? { initiator: from.initiator } : {}),
          question,
          ...(parsed.data.why ? { why: parsed.data.why } : {}),
          ...(parsed.data.parts
            ? { parts: parsed.data.parts.map(freeText) }
            : {}),
        });
      } catch (error) {
        /*
         * The thrown text goes in the trail and not into the answer.
         *
         * What a route throws is written for whoever operates the rota — a connection reset, a status
         * line, a stack — and the answer here is paraphrased to the person who asked the question.
         * `handoff-runner.ts` keeps the two apart for the same reason; this keeps the whole thing on
         * the row, capped, and gives the Bot a sentence that is true whatever went wrong.
         */
        thrown = (error instanceof Error ? error.message : String(error)).slice(
          0,
          400,
        );
        outcome = {
          refusal:
            "That did not reach anybody: nobody could be asked just now. Say so plainly, answer " +
            "only what you can settle yourself, and do not tell them a person has been asked.",
        };
      }

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
          ...(from.initiator ? { initiator: from.initiator } : {}),
          payload: {
            bot: from.botId,
            run: from.runId,
            question,
            ...(parsed.data.why ? { why: parsed.data.why } : {}),
            ...("reached" in outcome
              ? { reached: outcome.reached }
              : { reason: outcome.refusal }),
            // The route's own words, only when it threw them. `reason` above is the sentence the Bot
            // was given; this is what actually went wrong, which is the pair `store.ts` keeps too.
            ...(thrown ? { failure: thrown } : {}),
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
