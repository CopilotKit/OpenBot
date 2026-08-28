/**
 * The tool one Bot uses to hand work to another.
 *
 * Offered beside a Bot's granted tools rather than through a new transport, so which Bots may reach
 * which other Bots is an ordinary grant an administrator makes. A Bot with no such grant is offered
 * nothing and cannot address anybody, which is the correct default.
 *
 * WHAT IT TAKES IS TYPED, and that is the one place this departs from the obvious build. The natural
 * shape is `message_bot(target, message)` and free text is the commonest way a multi-agent system
 * goes quietly wrong: the receiving Bot infers the intent, re-derives the constraints and guesses
 * what shape of answer was wanted, and when it guesses wrong it does not fail, it returns something
 * else confidently. Naming the parts costs the asking model a little effort and removes most of that.
 */

import { z } from "zod";
import { HANDED_OVER } from "../../../shared/handoff-markers";
import type { GrantedTool } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";
import type { HandoffDesk } from "./handoff";

/** What the model is offered. One name, so a transcript can find every hop by searching for it. */
export const HANDOFF_TOOL = "message_bot";

const parameters = z.object({
  bot: z
    .string()
    .describe(
      "The name of the Bot to hand this to, as it appears in the roster",
    ),
  task: z
    .string()
    .describe("What you are asking that Bot to do, in a sentence or two"),
  constraints: z
    .string()
    .optional()
    .describe(
      "Anything that bounds the work: a date range, a system to look in, a rule it must not break",
    ),
  expecting: z
    .string()
    .optional()
    .describe(
      "What a good answer looks like coming back: a list, a number, a recommendation with reasons",
    ),
});

/**
 * The tool, for a run that is allowed to have it.
 *
 * Returns nothing when this deployment has switched handoff off, so a Bot in that deployment is not
 * offered a tool whose every call would be refused. A model offered a tool it may never use spends
 * attention on it and tells the person it tried.
 */
export function handoffTool(options: {
  desk: HandoffDesk;
  /** The run doing the asking, as this deployment signed it. */
  from: RunAssertion;
  /** Whether this Bot has been granted anybody at all. */
  hasSomebodyToAsk: boolean;
  maxDepth: number;
  /** How many Bots one run may address. Zero switches it off as surely as a depth of zero. */
  maxPerRun: number;
}): GrantedTool | null {
  const { desk, from, hasSomebodyToAsk, maxDepth, maxPerRun } = options;
  /*
   * Both zeros mean the same thing, and both have to be checked here.
   *
   * A run allowed to go no Bots deep and a run allowed to address no Bots are the same deployment
   * decision from two directions, and only one of them was closing the door. With a fan-out cap of
   * zero the tool was still offered, every call was refused by the desk, and the model spent
   * attention on it and told the person it had tried and failed, which reads as the deployment being
   * broken rather than as it being switched off.
   */
  if (maxDepth <= 0 || maxPerRun <= 0 || !hasSomebodyToAsk) return null;
  /*
   * Not offered to a run that is already as deep as this deployment allows.
   *
   * The desk refuses it anyway, so this is about what the model is shown rather than about the
   * boundary. A Bot at the cap that can see the tool will reach for it, be told no, and often tell
   * the person it tried and failed, which reads as the deployment being broken rather than as it
   * working.
   */
  if ((from.depth ?? 0) >= maxDepth) return null;

  return {
    name: HANDOFF_TOOL,
    ref: `bot/${HANDOFF_TOOL}`,
    description:
      "Hand a piece of work to another Bot in this workspace and let it answer for itself. " +
      "Use this when the work needs a role you do not have. The other Bot answers in its own " +
      "conversation with this person, so do not wait for it or repeat what it will say: tell them " +
      "who you have asked and what for. If the work is yours to do, do it, and if it needs a " +
      "person's judgement rather than another Bot's, ask the person instead.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        return "That handoff was not sent: name the Bot and say what you are asking it to do.";
      }
      const outcome = await desk.send({
        from,
        target: parsed.data.bot,
        envelope: {
          task: parsed.data.task,
          ...(parsed.data.constraints
            ? { constraints: parsed.data.constraints }
            : {}),
          ...(parsed.data.expecting
            ? { expecting: parsed.data.expecting }
            : {}),
        },
      });

      /*
       * A refusal comes back as a sentence, not an exception.
       *
       * The asking Bot is mid-run with a person waiting. A throw ends the run with nothing said,
       * which reads to the person as the Bot ignoring them; the refusal is in the audit trail either
       * way, and the model is owed something it can say out loud.
       */
      return outcome.ok
        ? `${HANDED_OVER}${outcome.toName}. It will answer in its own conversation with this person, so tell them you have asked it and what for, and do not answer on its behalf.`
        : outcome.refusal;
    },
  };
}

/** Re-exported so callers of this module do not need to know where it is declared. */
export { HANDED_OVER };
