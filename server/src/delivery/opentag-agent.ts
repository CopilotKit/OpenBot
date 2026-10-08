/**
 * The AG-UI agent OpenTag calls. See `opentag.ts` for the pairing contract.
 *
 * Order matters and is the whole security story: the shared secret first, then OpenTag's sender
 * context, then the person's authenticated delivery binding. Only a bound sender reaches a turn, and
 * only their own Bot in their own canonical thread. Everyone else is told how to link, and nothing
 * runs.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ApprovalDecision, approvalPreview } from "../approvals/types";
import {
  ingestSlackEvent,
  type SlackTriggerEvent,
} from "../responsibilities/slack";
import type { DrawnComponent } from "../routines/runner";
import {
  agUiStream,
  approvalFields,
  COMPONENT_CALL_PREFIX,
  chartForOpenTag,
  componentCallEvents,
  confirmWriteInterrupt,
  isComponentFollowUp,
  latestUserMessage,
  OPENTAG_CHART_TOOL,
  type OpenTagRunInput,
  type OpenTagTransport,
  parseChannelUser,
  parseOpenTagRunInput,
  resumeFromInput,
  senderFromContext,
  textEvents,
} from "./opentag";
import type { DeliveryRouter } from "./router";
import type { DeliveryStore } from "./store";
import {
  type ChatTransport,
  type DeliveryBinding,
  DeliveryRefusedError,
  type DeliveryScope,
} from "./types";

/** The approvals service, named by what a paired chat surface may do with it. */
export type PairedApprovals = {
  store: {
    get(
      ownerUserId: string,
      id: string,
    ): Promise<{
      status: string;
      action: {
        botId: string;
        toolRef: string;
        effect: string;
        threadId: string;
        args: unknown;
      };
    }>;
  };
  decide(
    ownerUserId: string,
    id: string,
    decision: ApprovalDecision,
  ): Promise<unknown>;
  answerQuestion(
    ownerUserId: string,
    id: string,
    response: string,
  ): Promise<unknown>;
  inbox(ownerUserId: string): Promise<{
    questions: { id: string; threadId: string; question: string }[];
  }>;
};

export type OpenTagAgentDeps = {
  opentag: OpenTagTransport;
  router: Pick<DeliveryRouter, "converse" | "notify">;
  store: Pick<
    DeliveryStore,
    | "findBinding"
    | "readChallenge"
    | "consumeChallenge"
    | "bind"
    | "botIdentity"
  >;
  scopeFor(
    owner: string,
    channelId: string,
    agentId: string,
  ): Promise<DeliveryScope | null>;
  approvals?: PairedApprovals;
  /** Slack trigger ingest; defaults to the responsibilities lane's `ingestSlackEvent`. */
  ingestSlack?: (event: SlackTriggerEvent) => Promise<unknown>;
  /**
   * OpenBot linked-account codes (Settings → Connected accounts) from a Slack sender. Reachability
   * codes are checked first; this is used for any code that is not a live one (an expired or used
   * Reachability code falls through too, matches no account code, and gets the usual expired reply).
   * An account code is redeemed only in a direct message. One posted in a shared conversation is
   * cancelled (`discard`), since anyone there could send it first and bind their own Slack account
   * to its issuer: with a mention the issuer is told to make a new one; without one (an observed
   * post) it is cancelled quietly and redacted before the Slack triggers see the message.
   */
  identity?: {
    redeem(
      code: string,
      sender: { teamId: string; userId: string },
    ): Promise<"linked" | "conflict" | "invalid">;
    /** Cancels a live account code; true when one was cancelled. */
    discard(code: string): Promise<boolean>;
  };
};

const LINK =
  /\blink\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const LINKS = new RegExp(LINK.source, "gi");

/**
 * A channel post the app was not mentioned in: everyone there has seen any account code in it, so
 * each one is cancelled, quietly (an observe run never replies). The codes are redacted rather than
 * the message dropped, so the post still fires the owners' message triggers without carrying a
 * code. A failed cancel is logged and never stops the triggers.
 */
async function withoutLinkCodes(
  deps: OpenTagAgentDeps,
  sender: { transport: ChatTransport },
  text: string,
) {
  const codes = [...text.matchAll(LINKS)].map((m) => m[1]?.toLowerCase());
  if (!codes.length) return text;
  if (sender.transport === "slack" && deps.identity)
    for (const code of codes) {
      if (!code) continue;
      try {
        await deps.identity.discard(code);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "opentag-link-code-discard-error",
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }
  return text.replace(LINKS, "link [code removed]");
}
const platformName = (transport: ChatTransport) =>
  transport === "teams" ? "Microsoft Teams" : "Slack";

export function linkInstructions(transport: ChatTransport) {
  return `I don't know who you are in OpenBot yet, so I did not run anything. In OpenBot, open Reachability, choose the conversation and Bot, pick ${platformName(transport)}, and send me the \`link <code>\` message it shows you.`;
}

export async function handleOpenTagRun(
  deps: OpenTagAgentDeps,
  request: Request,
): Promise<Response> {
  if (!deps.opentag.authenticates(request.headers.get("authorization")))
    return Response.json(
      { error: "Invalid OpenTag credentials." },
      { status: 401 },
    );
  let input: OpenTagRunInput;
  try {
    input = parseOpenTagRunInput(await request.json());
  } catch (error) {
    // Where the run failed to parse, never what it said: paths and codes only.
    console.error(
      JSON.stringify({
        type: "opentag-run-invalid",
        issues:
          error instanceof z.ZodError
            ? error.issues.slice(0, 10).map(({ path, code }) => ({
                path: path.join("."),
                code,
              }))
            : [
                {
                  path: "",
                  code: error instanceof Error ? error.name : "unknown",
                },
              ],
      }),
    );
    return Response.json(
      { error: "Supply a valid AG-UI run." },
      { status: 400 },
    );
  }
  const signal = request.signal;
  const stream = agUiStream(async (emit) => {
    const { threadId, runId } = input;
    emit({ type: "RUN_STARTED", threadId, runId });
    const say = (text: string) => {
      for (const event of textEvents(randomUUID(), text)) emit(event);
    };
    try {
      const outcome = await answer(deps, input, signal);
      say(outcome.text);
      // The Bot's charts, drawn natively by the Channel when it offers its chart component.
      if (input.tools.some((tool) => tool.name === OPENTAG_CHART_TOOL))
        for (const component of outcome.components ?? []) {
          const args = chartForOpenTag(component);
          if (!args) continue;
          for (const event of componentCallEvents(
            `${COMPONENT_CALL_PREFIX}${randomUUID()}`,
            OPENTAG_CHART_TOOL,
            args,
          ))
            emit(event);
        }
      if (outcome.interrupt)
        emit({
          type: "CUSTOM",
          name: "on_interrupt",
          value: outcome.interrupt,
        });
      emit({ type: "RUN_FINISHED", threadId, runId });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "opentag-run-error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      emit({
        type: "RUN_ERROR",
        message:
          error instanceof DeliveryRefusedError
            ? error.message
            : "OpenBot could not complete this turn. Try again, or open the conversation in OpenBot.",
      });
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function answer(
  deps: OpenTagAgentDeps,
  input: OpenTagRunInput,
  signal: AbortSignal,
): Promise<{
  text: string;
  interrupt?: unknown;
  components?: DrawnComponent[];
}> {
  // The Channel drew our chart and runs us again with its result; the turn already answered.
  if (isComponentFollowUp(input)) return { text: "" };
  const resume = resumeFromInput(input);
  if (resume) return decideFromCard(deps, resume);

  const sender = senderFromContext(input);
  if (!sender)
    return {
      text: "OpenTag did not say who sent this message, so OpenBot did not run anything. Update OpenTag to a version that forwards the OpenBot sender context.",
    };
  // Something to watch, not to answer: feed the owner's Slack triggers and stay quiet.
  if (sender.observe) {
    const text =
      sender.observe === "message" ? latestUserMessage(input)?.text : undefined;
    await feedSlackTriggers(deps, sender, {
      type: sender.observe,
      text: text && (await withoutLinkCodes(deps, sender, text)),
    });
    return { text: "" };
  }
  const message = latestUserMessage(input);
  if (!message?.text)
    return { text: "Send me a message and I'll pass it to your Bot." };

  const code = LINK.exec(message.text)?.[1];
  if (code) return link(deps, sender, code.toLowerCase());

  // One event per Slack message: a mention is `app_mention` only, never also a `message`. Fed
  // whether or not the author linked OpenBot: owners' triggers are decided by their own access.
  await feedSlackTriggers(deps, sender, {
    type: sender.mentioned ? "app_mention" : "message",
    text: message.text,
  });
  const bound = await ownedBinding(deps, sender);
  if (!bound) return { text: linkInstructions(sender.transport) };
  const answered = await answerOpenQuestion(deps, bound, message.text);
  if (answered) {
    const bot = await deps.store.botIdentity(bound.agentId);
    return {
      text: `Thanks. I passed your answer to ${bot?.name ?? "your Bot"}; it is continuing and will reply here.`,
    };
  }

  const result = await deps.router.converse({
    transport: sender.transport,
    realm: sender.realm,
    identity: sender.identity,
    // The platform event id survives an agent retry; the AG-UI message id is the fallback.
    externalId: sender.event
      ? `event:${sender.event}`
      : `${input.threadId}:${message.id ?? input.runId}`,
    text: message.text,
    signal,
  });
  if (result.kind === "unbound")
    return { text: linkInstructions(sender.transport) };
  if (result.kind === "duplicate")
    return { text: "I already passed that message to your Bot." };
  if (result.kind === "failed") return { text: `${result.message}` };

  if (!sender.private) return answerPrivately(deps, result);

  const questions = result.extras.questions.map((q) => q.text);
  const approvalId = result.extras.approvals[0];
  const parts = [result.replyText, ...questions].filter(Boolean);
  if (questions.length) parts.push("Reply here to answer.");
  if (approvalId) {
    const card = await approvalCard(deps, result.binding, approvalId);
    if (result.extras.approvals.length > 1)
      parts.push(
        `${result.extras.approvals.length - 1} more approval request(s) are waiting in your OpenBot approval inbox.`,
      );
    if (card) return { text: parts.join("\n\n"), interrupt: card };
    parts.push(
      "Your Bot is waiting for an approval. Open your OpenBot approval inbox to review it.",
    );
  } else if (result.kind === "waiting" && !parts.length) {
    parts.push("Your Bot is waiting for a person. Open OpenBot to continue.");
  }
  return {
    text: parts.join("\n\n") || "Done.",
    ...(result.components ? { components: result.components } : {}),
  };
}

/**
 * The conversation may include other people, and the turn's output comes from the owner's private
 * conversation. So none of it is posted in the thread: the reply, questions and approval requests go
 * to the owner through the delivery outbox (their DM with the app, their other linked channels, their
 * phone), where failures are visible, and the thread only says where the answer went.
 */
async function answerPrivately(
  deps: OpenTagAgentDeps,
  result: Extract<
    Awaited<ReturnType<DeliveryRouter["converse"]>>,
    { extras: unknown }
  >,
) {
  const scope = {
    ownerUserId: result.binding.ownerUserId,
    channelId: result.binding.channelId,
    agentId: result.binding.agentId,
    threadId: result.binding.threadId,
  };
  if (result.replyText)
    await deps.router.notify(scope, {
      id: `opentag-reply:${result.inboxId}`,
      text: result.replyText,
      kind: "reply",
    });
  for (const question of result.extras.questions)
    await deps.router.notify(scope, {
      id: question.id,
      text: question.text,
      kind: "question",
      requestId: question.id,
    });
  const bot = await deps.store.botIdentity(result.binding.agentId);
  for (const approvalId of result.extras.approvals)
    await deps.router.notify(scope, {
      id: approvalId,
      text: `${bot?.name ?? "Your Bot"} is waiting for your approval. Open your OpenBot approval inbox to review it.`,
      kind: "approval",
      requestId: approvalId,
    });
  return {
    text: "Other people may be able to read this conversation, so I sent my answer to you directly.",
  };
}

/**
 * A message from a bound person who has an open question from this Bot answers that question.
 * Checked before running a fresh turn so the reply resumes the question's own continuation.
 */
export async function answerOpenQuestion(
  deps: OpenTagAgentDeps,
  binding: DeliveryBinding,
  text: string,
) {
  if (!deps.approvals) return null;
  const { questions } = await deps.approvals.inbox(binding.ownerUserId);
  const open = questions.find((q) => q.threadId === binding.threadId);
  if (!open) return null;
  await deps.approvals.answerQuestion(binding.ownerUserId, open.id, text);
  return open;
}

async function link(
  deps: OpenTagAgentDeps,
  sender: {
    transport: ChatTransport;
    realm: string;
    identity: string;
    private: boolean;
  },
  code: string,
) {
  const challenge = await deps.store.readChallenge(code);
  if (!challenge && sender.transport === "slack" && deps.identity) {
    // Anyone else in a shared conversation has now seen the code and could send it first, binding
    // their own Slack account to its issuer, so an account code is only redeemed in a direct
    // message and one posted here is cancelled (an unmentioned channel post is cancelled in
    // `withoutLinkCodes`).
    if (!sender.private) {
      if (await deps.identity.discard(code))
        return {
          text: "That code was posted where others could see it, so I cancelled it. Create a new one in OpenBot and send it to me in a direct message.",
        };
      return {
        text: "That link code expired, was already used, or is for another app. Create a new one in OpenBot.",
      };
    }
    const outcome = await deps.identity.redeem(code, {
      teamId: sender.realm,
      userId: sender.identity,
    });
    if (outcome === "linked")
      return {
        text: "Linked your Slack account to OpenBot. You can see it under Settings → Connected accounts.",
      };
    if (outcome === "conflict")
      return {
        text: "This Slack account is already linked to another OpenBot user.",
      };
  }
  if (!challenge || challenge.transport !== sender.transport)
    return {
      text: "That link code expired, was already used, or is for another app. Create a new one in OpenBot.",
    };
  const scope = await deps.scopeFor(
    challenge.ownerUserId,
    challenge.channelId,
    challenge.agentId,
  );
  if (
    !scope ||
    scope.threadId !== challenge.threadId ||
    !(await deps.store.consumeChallenge(code, challenge.ownerUserId))
  )
    return {
      text: "That conversation changed. Create a new link code in OpenBot.",
    };
  try {
    await deps.store.bind({
      ...scope,
      transport: sender.transport,
      realm: sender.realm,
      identity: sender.identity,
      // Slack delivers a message addressed to a user id into that user's DM with the app.
      address: sender.identity,
    });
  } catch (error) {
    if (error instanceof DeliveryRefusedError) return { text: error.message };
    throw error;
  }
  const bot = await deps.store.botIdentity(scope.agentId);
  return {
    text: `Linked. Messages you send me here now go to ${bot?.name ?? "your Bot"} in your OpenBot conversation, and its questions and approval requests will reach you here.`,
  };
}

async function approvalCard(
  deps: OpenTagAgentDeps,
  binding: DeliveryBinding,
  approvalId: string,
) {
  if (!deps.approvals) return null;
  let record: Awaited<ReturnType<PairedApprovals["store"]["get"]>>;
  try {
    record = await deps.approvals.store.get(binding.ownerUserId, approvalId);
  } catch {
    return null;
  }
  if (
    record.status !== "pending" ||
    record.action.threadId !== binding.threadId
  )
    return null;
  const bot = await deps.store.botIdentity(record.action.botId);
  return confirmWriteInterrupt({
    approvalId,
    action: `${bot?.name ?? "Your Bot"}: ${record.action.toolRef}`,
    approver: `${binding.transport}:${binding.identity}`,
    effect: record.action.effect,
    // The approvals preview already redacts secrets and private content.
    fields: approvalFields(approvalPreview(record.action.args)),
  });
}

async function decideFromCard(
  deps: OpenTagAgentDeps,
  resume: NonNullable<ReturnType<typeof resumeFromInput>>,
): Promise<{ text: string }> {
  if (resume.invalid)
    return {
      text: "That approval answer could not be read, so nothing was decided.",
    };
  if (!deps.approvals)
    return {
      text: "Approvals from chat are unavailable on this deployment. Decide in your OpenBot approval inbox.",
    };
  const person = parseChannelUser(resume.by);
  if (!person)
    return {
      text: "This approval card did not say who answered it, so nothing was decided. Update OpenTag, or decide in your OpenBot approval inbox.",
    };
  // The clicker is mapped exactly like a message sender; OpenTag already refused anyone but the
  // named approver, and OpenBot then decides only as that binding's owner.
  const binding = await ownedBinding(deps, person);
  if (!binding)
    return {
      text: "You are not linked to this approval's owner, so nothing was decided.",
    };
  let record: Awaited<ReturnType<PairedApprovals["store"]["get"]>>;
  try {
    record = await deps.approvals.store.get(
      binding.ownerUserId,
      resume.approvalId,
    );
  } catch {
    return {
      text: "That approval is not yours or no longer exists, so nothing was decided.",
    };
  }
  if (record.action.threadId !== binding.threadId)
    return {
      text: "That approval belongs to another conversation, so nothing was decided.",
    };
  if (record.status !== "pending")
    return {
      text: "That approval was already decided. Check its result in OpenBot.",
    };
  const decision: ApprovalDecision = !resume.confirmed
    ? "deny"
    : resume.always
      ? "allow_always"
      : "allow_once";
  await deps.approvals.decide(binding.ownerUserId, resume.approvalId, decision);
  const bot = await deps.store.botIdentity(record.action.botId);
  const name = bot?.name ?? "Your Bot";
  return {
    text:
      decision === "deny"
        ? `Denied. ${name} will not run ${record.action.toolRef}.`
        : `${decision === "allow_always" ? "Always allowed" : "Allowed once"}. ${name} is continuing and will send its result here.`,
  };
}

/**
 * Hand a verified Slack event to the responsibilities lane, for the linked owner's own Bot. Only
 * for a bound sender: an unlinked person names no owner, so their events fire nobody's triggers.
 * Never fails the chat turn; a trigger problem is logged where an operator can find it.
 */
async function feedSlackTriggers(
  deps: OpenTagAgentDeps,
  sender: NonNullable<ReturnType<typeof senderFromContext>>,
  event: { type: SlackTriggerEvent["type"]; text?: string },
) {
  if (
    sender.transport !== "slack" ||
    !sender.event ||
    !sender.conversationId ||
    !/^[A-Z0-9]{2,32}$/.test(sender.realm)
  )
    return;
  // The managed Channel does not expose Slack's own `ts`, so the delivery time stands in for it.
  const now = Math.floor(Date.now() / 1000);
  try {
    await (deps.ingestSlack ?? ingestSlackEvent)({
      teamId: sender.realm,
      eventId: sender.event,
      eventTime: now,
      type: event.type,
      channelId: sender.conversationId,
      userId: sender.identity,
      ts: `${now}.000000`,
      ...(event.text ? { text: event.text.slice(0, 40_000) } : {}),
      ...(event.type === "reaction_added" && sender.reaction
        ? { reaction: sender.reaction }
        : {}),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "opentag-slack-trigger-error",
        errorType: error instanceof Error ? error.name : "UnknownError",
        message:
          error instanceof Error ? error.message.slice(0, 200) : undefined,
      }),
    );
  }
}

/** The sender's enabled binding, only while its owner still has that conversation and Bot. */
async function ownedBinding(
  deps: OpenTagAgentDeps,
  person: { transport: ChatTransport; realm: string; identity: string },
) {
  const binding = await deps.store.findBinding(
    person.transport,
    person.realm,
    person.identity,
  );
  if (!binding) return null;
  const scope = await deps.scopeFor(
    binding.ownerUserId,
    binding.channelId,
    binding.agentId,
  );
  return scope?.threadId === binding.threadId ? binding : null;
}
