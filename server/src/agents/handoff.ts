/**
 * One Bot handing work to another.
 *
 * A person can put several Bots in a channel and address them with `@`. What they could not do is
 * let one Bot bring in another: every hop went through a person, who read the answer, decided who
 * should see it next, and pasted it across.
 *
 * THIS IS THE PART THAT DECIDES, not the part that delivers. It resolves who is being addressed,
 * refuses when it should, writes the row that says what happened, and puts a durable hop on the
 * queue. What claims that hop and runs the other Bot is `handoff-runner.ts`, and the split is
 * deliberate: deciding happens inside somebody's run and must be fast and fail closed, while
 * delivering is a whole agent turn that has to survive the pod it started on.
 *
 * EVERY REFUSAL IS AN ANSWER, NOT AN ERROR. The asking Bot is mid-run with a person waiting, so a
 * refusal comes back as a sentence it can say. A thrown error ends the run with nothing said, which
 * reads to the person as the Bot ignoring them.
 */
import { createHash } from "node:crypto";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { WorkQueue } from "../work/queue";
import type { RunAssertion } from "./callback-token";
import type { AgentProfileStore } from "./profile-store";

/** The kind of work a hop is, on the shared queue. */
export const HANDOFF_KIND = "bot.message";

/** The kind of grant that lets one Bot address another. */
export const HANDOFF_GRANT = "bot";

/**
 * What one Bot sends another.
 *
 * TYPED FIELDS, NOT A PARAGRAPH, and this is the one decision here taken against the obvious build.
 * The natural shape is `message_bot(target, message)` and it is what the issue proposed. Free text is
 * the commonest way a multi-agent system goes quietly wrong: the receiving Bot has to infer the
 * intent, re-derive the constraints and guess what shape of answer was wanted, and when it guesses
 * wrong it does not fail, it confidently returns something else. Naming the parts costs the asking
 * model a little more effort and removes most of that.
 */
export type HandoffEnvelope = {
  /** What the other Bot is being asked to do. */
  task: string;
  /** Anything that bounds it: a date range, a system, a rule it must not break. */
  constraints?: string;
  /** What good looks like coming back: a list, a number, a recommendation with reasons. */
  expecting?: string;
};

/** How far this may go, in numbers a deployment chooses rather than constants. */
export type HandoffCaps = {
  /** How many Bots deep a chain may go. Zero means one Bot may never address another. */
  maxDepth: number;
  /** How many other Bots one run may address. */
  maxPerRun: number;
};

export type HandoffOutcome =
  | { ok: true; to: string; toName: string }
  | { ok: false; refusal: string };

export type HandoffDesk = {
  send: (input: {
    /**
     * The run doing the asking, as this deployment signed it.
     *
     * Where the answer goes comes from here too. A Bot naming its own thread would be a Bot able to
     * drop a turn into a conversation it was never part of.
     */
    from: RunAssertion;
    /** The Bot being addressed, as the model named it. */
    target: string;
    envelope: HandoffEnvelope;
  }) => Promise<HandoffOutcome>;
};

export function createHandoffDesk(options: {
  queue: WorkQueue;
  profiles: AgentProfileStore;
  /** Whether the asking Bot has been granted the Bot it is addressing. Read per hop, never cached. */
  mayAddress: (fromBotId: string, toBotId: string) => Promise<boolean>;
  auditStore: AuditStore;
  caps: HandoffCaps;
}): HandoffDesk {
  const { queue, profiles, mayAddress, auditStore, caps } = options;

  /** Said once, so the trail carries the same words the Bot was given. */
  async function refuse(
    from: RunAssertion,
    target: string,
    reason: string,
    refusal: string,
  ): Promise<HandoffOutcome> {
    await recordAuditEvent(auditStore, {
      eventType: "agent.handoff_refused",
      targetType: "agent",
      targetId: from.botId,
      ...(from.actorId ? { actorUserId: from.actorId } : {}),
      payload: {
        from: from.botId,
        // As the model named it, capped: untrusted input, kept because "who did it reach for" is the
        // useful half of the question.
        target: target.slice(0, 120),
        run: from.runId,
        depth: from.depth ?? 0,
        reason,
      },
    });
    return { ok: false, refusal };
  }

  return {
    async send({ from, target, envelope }) {
      const task = envelope.task?.trim() ?? "";
      if (!task) {
        return refuse(
          from,
          target,
          "no_task",
          "Nothing was sent: a handoff has to say what the other Bot is being asked to do.",
        );
      }

      if (!from.threadId) {
        return refuse(
          from,
          target,
          "no_thread",
          "This run is not in a conversation, so there is nowhere for another Bot's answer to land.",
        );
      }

      /*
       * The depth cap first, because it is the one that stops a loop.
       *
       * A asks B asks C asks A is the obvious failure and it spends real money going round. The count
       * arrives in the signed assertion, so it is the deployment's number rather than anything the
       * model can edit, and it is already correct on whichever pod this run landed on.
       */
      const depth = from.depth ?? 0;
      if (depth >= caps.maxDepth) {
        return refuse(
          from,
          target,
          "depth_cap",
          caps.maxDepth === 0
            ? "This deployment does not let one Bot hand work to another."
            : `This is already ${depth} ${depth === 1 ? "Bot" : "Bots"} deep, which is as far as this deployment allows. Answer with what you have, or ask the person.`,
        );
      }

      /*
       * And the fan-out cap, counted from the rows rather than from a variable.
       *
       * Counting in a process counts one pod, and a run whose hops land on several pods is exactly
       * what this exists to bound. Every hop this run has offered is a row, so the rows are the count.
       */
      const already = await queue.count({
        kind: HANDOFF_KIND,
        keyPrefix: `${from.runId}:`,
      });
      if (already >= caps.maxPerRun) {
        return refuse(
          from,
          target,
          "fanout_cap",
          `This turn has already asked ${already} ${already === 1 ? "Bot" : "Bots"}, which is as many as this deployment allows. Answer with what you have, or ask the person.`,
        );
      }

      /*
       * Resolved against the roster the ASKING PERSON may see, never taken from the model.
       *
       * A Bot must not be able to reach a Bot its person cannot, or this becomes a way around agent
       * visibility: the model would name anything and the deployment would go and find it.
       */
      const roster = await profiles.list({ id: from.actorId, role: "user" });
      const wanted = target.trim().toLowerCase();
      const found = roster.find(
        (candidate) =>
          candidate.id.toLowerCase() === wanted ||
          candidate.name.toLowerCase() === wanted,
      );

      /*
       * The same answer whether it does not exist or is not theirs to see.
       *
       * Two different sentences here would let a Bot enumerate the deployment's roster by asking for
       * names and reading which refusal came back.
       */
      if (!found || found.hidden || found.deletedAt !== null) {
        return refuse(
          from,
          target,
          "no_such_bot",
          `There is no Bot called "${target.trim().slice(0, 60)}" that you can reach.`,
        );
      }

      if (found.id === from.botId) {
        return refuse(
          from,
          target,
          "self",
          "A Bot cannot hand work to itself. Do it, or ask the person.",
        );
      }

      // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
      // restart.
      if (!(await mayAddress(from.botId, found.id))) {
        return refuse(
          from,
          target,
          "not_granted",
          `You have not been given ${found.name} to hand work to. An administrator grants that.`,
        );
      }

      /*
       * The key is what stops this happening twice.
       *
       * `offer` is idempotent on it, and that is the only thing between a retried delivery and a
       * second run of the receiving Bot. So it is derived from the run and the contents of the
       * envelope rather than from a fresh id: the same request, sent twice in one run, is one hop.
       * That is the honest reading of a model repeating itself, and the alternative is at-least-once
       * with no ceiling.
       */
      const key = `${from.runId}:${createHash("sha256")
        .update(
          JSON.stringify([
            found.id,
            task,
            envelope.constraints ?? "",
            envelope.expecting ?? "",
          ]),
        )
        .digest("hex")
        .slice(0, 32)}`;

      await queue.offer({
        kind: HANDOFF_KIND,
        key,
        payload: {
          fromBotId: from.botId,
          toBotId: found.id,
          actorId: from.actorId,
          threadId: from.threadId,
          runId: from.runId,
          /*
           * One deeper than the run that asked. The receiving Bot's own assertion is minted from
           * this, so the cap keeps counting across every pod the chain touches.
           */
          depth: depth + 1,
          /*
           * The asking Bot's display name, resolved here against the same roster the target was.
           *
           * The delivery writes one line of this into the addressed Bot's conversation, and a person
           * reading it should see "General Assistant" rather than `general-assistant`. Resolved on
           * this side because this is the side holding the roster; the delivery runs minutes later
           * on another replica and would have to fetch it again.
           */
          ...(roster.find((profile) => profile.id === from.botId)?.name
            ? {
                fromName: roster.find((profile) => profile.id === from.botId)
                  ?.name,
              }
            : {}),
          toName: found.name,
          task,
          ...(envelope.constraints
            ? { constraints: envelope.constraints }
            : {}),
          ...(envelope.expecting ? { expecting: envelope.expecting } : {}),
        },
      });

      await recordAuditEvent(auditStore, {
        eventType: "agent.handoff_offered",
        targetType: "agent",
        targetId: found.id,
        ...(from.actorId ? { actorUserId: from.actorId } : {}),
        payload: {
          from: from.botId,
          to: found.id,
          run: from.runId,
          depth: depth + 1,
          // What was asked, so the trail says what one Bot sent another rather than merely that it
          // did. The task is the Bot's own words about the work, not a person's private content.
          task: task.slice(0, 500),
        },
      });

      return { ok: true, to: found.id, toName: found.name };
    },
  };
}
