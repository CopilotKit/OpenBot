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

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { HANDED_OVER } from "../../../shared/handoff-markers";
import {
  type ApprovalGate,
  ApprovalRefusedError,
  currentApprovalContext,
} from "../approvals/types";
import { type AuditStore, PERSON_INITIATOR, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { workItems } from "../db/schema";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import type {
  CheckPrivateShare,
  PrivateShareInput,
  ShareAudience,
} from "../proactive/private-share";
import type { RunAssertion } from "./callback-token";
import {
  ESCALATE_TOOL,
  type EscalationRoute,
  escalationTool,
  PUT_TO,
} from "./escalation";
import { HANDOFF_KIND, type HandoffCaps, type HandoffDesk } from "./handoff";
import type { HandoffWork } from "./handoff-runner";

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
  /**
   * The person's approval gate. Delegation is an action like any other: custom rules, auto-review
   * and "ask before" apply to handing work to another Bot, as Grok Bot reviews subagent launches.
   */
  approvalGate?: ApprovalGate;
  privateShare?: PrivateShareGate;
}): GrantedTool | null {
  const {
    desk,
    from,
    hasSomebodyToAsk,
    maxDepth,
    maxPerRun,
    approvalGate,
    privateShare,
  } = options;
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
      if (approvalGate) {
        try {
          const approval = await approvalGate({
            actorId: from.actorId,
            botId: from.botId,
            toolRef: `bot/${HANDOFF_TOOL}`,
            effect: "delegate",
            scope: parsed.data.bot,
            args: parsed.data,
            target: { bot: parsed.data.bot },
            continuation: currentApprovalContext(),
          });
          // A decided hand-off or a replayed result: the work was dealt with, so it is not sent again.
          if (approval && "replay" in approval)
            return typeof approval.replay === "string"
              ? approval.replay
              : JSON.stringify(approval.replay);
        } catch (error) {
          if (error instanceof ApprovalRefusedError)
            return `That handoff was not sent: ${error.message}`;
          // A pending approval suspends the run through the normal AG-UI interrupt.
          throw error;
        }
      }
      /*
       * Work handed to ANOTHER person's Bot carries the owner's private conversation to someone else,
       * so the owner has to have allowed it. Checked before anything is sent; nothing is sent while
       * it waits or after a no.
       */
      const audience = await privateShare?.audienceFor(from, parsed.data.bot);
      if (privateShare && audience) {
        const held = await sharePermission(privateShare, {
          from,
          audience,
          origin: { kind: "private_conversation" },
          content: [
            parsed.data.task,
            parsed.data.constraints,
            parsed.data.expecting,
          ],
          refused: "That handoff was not sent",
        });
        if (held) return held;
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
        ? `${HANDED_OVER}${outcome.toName}. It has not replied yet: its answer arrives later as a separate message in this conversation. End your turn now with one sentence telling the person you asked it and what for, and do not answer on its behalf. Anything you say is its answer before then would be made up, even if you know the answer yourself.`
        : outcome.refusal;
    },
  };
}

/**
 * The private-information check for a handoff, supplied by the process. `audienceFor` answers null
 * for a Bot the owner's own, and otherwise names the other person who will read the work.
 */
export type PrivateShareGate = {
  check: CheckPrivateShare;
  audienceFor: (
    from: RunAssertion,
    target: string,
  ) => Promise<ShareAudience | null>;
  /**
   * Who besides the owner would read an `ask_person` question from this run, and where the run's
   * content came from. Null when only the owner reads it, which is the ordinary case.
   */
  questionAudience?: (from: RunAssertion) => Promise<{
    audience: ShareAudience;
    origin: PrivateShareInput["origin"];
  } | null>;
};

/**
 * Asks the private-share check and turns a hold into what the tool answers. Undefined means go
 * ahead. A turn nobody is watching waits durably and resumes on the decision; a person's own turn is
 * answered, so the model tells them what it is waiting for.
 */
async function sharePermission(
  gate: PrivateShareGate,
  input: {
    from: RunAssertion;
    audience: ShareAudience;
    origin: PrivateShareInput["origin"];
    content: (string | undefined)[];
    refused: string;
  },
): Promise<string | undefined> {
  const continuation = currentApprovalContext();
  const verdict = await gate.check({
    ownerUserId: input.from.actorId,
    botId: input.from.botId,
    audience: input.audience,
    content: input.content.filter(Boolean).join("\n\n"),
    origin: input.origin,
    ...(continuation ? { continuation } : {}),
  });
  if (verdict.status === "allowed") return undefined;
  if (verdict.status === "denied")
    return `${input.refused}: ${verdict.message}`;
  const initiator = continuation?.initiator;
  if (initiator && initiator.kind !== "person") throw verdict.suspension;
  return `${input.refused} yet: ${verdict.message} Tell the person you are waiting for their permission on your page in OpenBot.`;
}

/** Re-exported so callers of this module do not need to know where it is declared. */
export { HANDED_OVER };

export type CoordinationRunAuthority = {
  /** Resolve the current actor and Bot visibility, rather than trusting their former access. */
  canUseBot: (run: RunAssertion) => Promise<boolean>;
  /** The actor's current membership and the source thread's actual Bot. */
  sourceThread: (run: RunAssertion) => Promise<{ botId: string } | null>;
  /** Read the signed claim by key; active must use the database clock and exclude finished work. */
  delegationFor: (claim: NonNullable<RunAssertion["handoff"]>) => Promise<{
    work: HandoffWork;
    owner: string;
    active: boolean;
  } | null>;
};

/* ROOT INITIATORS a handed-over run may trace back to — a person, the deployment itself,
 * or something that named an id when it kicked the work off. A handoff's own initiator is
 * layered on top of this union below, carrying one of these roots as its optional origin. */
const rootInitiator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }),
  z.object({ kind: z.literal("deployment") }),
  z.object({ kind: z.literal("routine"), id: z.string().min(1) }),
  z.object({ kind: z.literal("responsibility"), id: z.string().min(1) }),
  z.object({ kind: z.literal("memory"), id: z.string().min(1) }),
]);

export const delegatedWork = z.object({
  fromBotId: z.string().min(1),
  toBotId: z.string().min(1),
  actorId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  task: z.string(),
  initiator: z
    .union([
      rootInitiator,
      z.object({
        kind: z.literal("handoff"),
        id: z.string().min(1),
        origin: rootInitiator.optional(),
      }),
    ])
    .optional(),
});

/** Only the current database-clock lease holder may make new coordination calls during delivery. */
export async function readCoordinationHandoffClaim(
  database: Database,
  claim: NonNullable<RunAssertion["handoff"]>,
): ReturnType<CoordinationRunAuthority["delegationFor"]> {
  const [row] = await database
    .select({ payload: workItems.payload })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, HANDOFF_KIND),
        eq(workItems.key, claim.key),
        eq(workItems.claimedBy, claim.owner),
        isNull(workItems.finishedAt),
        sql`${workItems.leaseUntil} > now()`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = delegatedWork.safeParse(row.payload);
  if (!parsed.success)
    throw new Error("The active handoff claim has invalid work context.");
  return { work: parsed.data, owner: claim.owner, active: true };
}

/** Direct runs own their source; delegated runs prove a currently leased hop into that source. */
export async function authoriseCoordinationRun(
  run: RunAssertion,
  authority: CoordinationRunAuthority,
): Promise<boolean> {
  if (!run.threadId || !(await authority.canUseBot(run))) return false;
  const source = await authority.sourceThread(run);
  if (!source) return false;
  if (!run.handoff) return (run.depth ?? 0) === 0 && source.botId === run.botId;
  const claim = await authority.delegationFor(run.handoff);
  if (!claim?.active || claim.owner !== run.handoff.owner) return false;
  const work = claim.work;
  const workInitiator = work.initiator ?? PERSON_INITIATOR;
  const runInitiator = run.initiator ?? PERSON_INITIATOR;
  return (
    work.toBotId === run.botId &&
    work.actorId === run.actorId &&
    work.threadId === run.threadId &&
    work.depth === (run.depth ?? 0) &&
    workInitiator.kind === runInitiator.kind &&
    ("id" in workInitiator ? workInitiator.id : undefined) ===
      ("id" in runInitiator ? runInitiator.id : undefined)
  );
}

/** Shared definitions and execution for built-in runs and authenticated remote callbacks. */
export function createCoordinationTools(options: {
  desk: HandoffDesk;
  caps: HandoffCaps;
  botsReachableFrom: (botId: string) => Promise<readonly string[]>;
  route: EscalationRoute;
  auditStore: AuditStore;
  authoriseRun: (run: RunAssertion) => Promise<boolean>;
  approvalGate?: ApprovalGate;
  privateShare?: PrivateShareGate;
}) {
  const asking = (from: RunAssertion): GrantedTool => {
    const tool = escalationTool({
      from,
      route: options.route,
      auditStore: options.auditStore,
    });
    const gate = options.privateShare;
    if (!gate?.questionAudience) return tool;
    const questionAudience = gate.questionAudience;
    return {
      ...tool,
      /*
       * A question that would reach somebody besides the owner, a group conversation or a shared
       * channel, carries the owner's private work to them, so it waits for the owner's permission
       * like a handoff to another person's Bot. Nothing is put to anybody while it waits.
       */
      execute: async (args: unknown) => {
        const reach = await questionAudience(from);
        if (reach) {
          const input = (args ?? {}) as { question?: unknown; why?: unknown };
          const held = await sharePermission(gate, {
            from,
            audience: reach.audience,
            origin: reach.origin,
            content: [
              typeof input.question === "string" ? input.question : undefined,
              typeof input.why === "string" ? input.why : undefined,
            ],
            refused: "That was not put to anybody",
          });
          if (held) return held;
        }
        return tool.execute(args);
      },
    };
  };
  return {
    async toolsForRun(from: RunAssertion): Promise<GrantedTool[]> {
      // Offered only when `call` would accept it: a group peer turn at depth 1 holds no handoff
      // claim, so every call from it was refused and audited. `call` still checks, for stale schemas.
      if (!(await options.authoriseRun(from))) return [];
      const canHandOn =
        options.caps.maxDepth > 0 &&
        options.caps.maxPerRun > 0 &&
        (from.depth ?? 0) < options.caps.maxDepth;
      const passing = canHandOn
        ? handoffTool({
            desk: options.desk,
            from,
            hasSomebodyToAsk:
              (await options.botsReachableFrom(from.botId)).length > 0,
            ...options.caps,
            ...(options.approvalGate
              ? { approvalGate: options.approvalGate }
              : {}),
            ...(options.privateShare
              ? { privateShare: options.privateShare }
              : {}),
          })
        : null;
      return passing ? [passing, asking(from)] : [asking(from)];
    },
    async call(input: {
      name: string;
      args: Record<string, unknown>;
      run: RunAssertion;
    }): Promise<{ text: string; isError: boolean } | null> {
      const name = input.name.replace(/^bot\//, "");
      if (name !== HANDOFF_TOOL && name !== ESCALATE_TOOL) return null;
      if (!(await options.authoriseRun(input.run))) {
        const text = `${REFUSAL_MARKER} This run no longer has permission to coordinate work in this conversation.`;
        await recordAuditEvent(options.auditStore, {
          eventType: "mcp.callback_refused",
          targetType: "agent",
          targetId: input.run.botId,
          actorUserId: input.run.actorId,
          ...(input.run.initiator ? { initiator: input.run.initiator } : {}),
          payload: {
            bot: input.run.botId,
            run: input.run.runId,
            tool: name,
            reason: "coordination_scope_refused",
          },
        });
        return { text, isError: true };
      }
      // Availability only controls offered schemas. A stale remote schema still reaches the desk,
      // which performs and audits the live grant and cap checks with the original signed depth.
      const tool =
        name === HANDOFF_TOOL
          ? handoffTool({
              desk: options.desk,
              from: input.run,
              hasSomebodyToAsk: true,
              maxDepth: Number.POSITIVE_INFINITY,
              maxPerRun: Number.POSITIVE_INFINITY,
              ...(options.approvalGate
                ? { approvalGate: options.approvalGate }
                : {}),
              ...(options.privateShare
                ? { privateShare: options.privateShare }
                : {}),
            })
          : asking(input.run);
      if (!tool)
        throw new Error("The coordination tool could not be constructed.");
      const text = await tool.execute(input.args);
      const isError = !text.startsWith(
        name === HANDOFF_TOOL ? HANDED_OVER : PUT_TO,
      );
      return { text: isError ? `${REFUSAL_MARKER} ${text}` : text, isError };
    },
  };
}
