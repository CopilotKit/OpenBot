import { isDeepStrictEqual } from "node:util";
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import type { IntelligenceLike } from "@openbot/toolkit/run-turn";
import { type RunAssertion, readRunAssertion } from "../agents/callback-token";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { type AuditInitiator, PERSON_INITIATOR } from "../audit";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import type { DeliveryScope } from "../delivery/types";
import type { ReviewModel } from "./policy";
import { createApprovalQuestions, type PersonQuestion } from "./questions";
import { createApprovalService } from "./service";
import { ApprovalRefusedError, type ApprovalStore } from "./types";

type ThreadHistory = Awaited<
  ReturnType<Pick<IntelligenceLike, "getThreadMessages">["getThreadMessages"]>
>;

/**
 * The saved copy of the call the browser is about to run, read back from the conversation.
 *
 * Intelligence saves a streaming run's messages a moment behind the stream, and the browser runs
 * the tool as soon as the call arrives. It saves the call's arguments delta by delta too, so a read
 * can find the call with half its arguments: that is not a mismatch yet, any more than a call not
 * saved yet is. Either is waited for briefly; one that never appears whole does not match, and the
 * caller refuses it.
 */
export async function savedToolCall(
  read: () => Promise<ThreadHistory>,
  snapshot: { toolCallId: string; toolName: string; args: unknown },
  wait: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ matches: boolean; answered: boolean }> {
  const attempts = wait.attempts ?? 10;
  const sleep = wait.sleep ?? ((ms: number) => Bun.sleep(ms));
  let history = await read();
  const matches = () => {
    const call = history.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((saved) => saved.id === snapshot.toolCallId);
    if (!call || call.name !== snapshot.toolName) return false;
    try {
      return isDeepStrictEqual(JSON.parse(call.args), snapshot.args);
    } catch {
      // Arguments still being saved.
      return false;
    }
  };
  for (let attempt = 0; !matches() && attempt < attempts; attempt++) {
    await sleep(500);
    history = await read();
  }
  return {
    matches: matches(),
    answered: history.messages.some(
      (message) =>
        message.role === "tool" && message.toolCallId === snapshot.toolCallId,
    ),
  };
}

/**
 * The deployment's approval service: the stored approvals, told the person's channel when one
 * opens; the question store; and a computer tool resumed only when its call is really saved in the
 * conversation it claims to come from.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because delivery is assigned after
 * this is created, and a notice reads it when an approval opens, never when this is built.
 */
export function createServerApprovalService(deps: {
  storedApprovals: ApprovalStore;
  config: Pick<DeploymentConfig, "keyEncryptionKey">;
  sourceForCoordinationRun: (
    run: RunAssertion,
  ) => Promise<{ channelId: string; botId: string } | null>;
  agentProfileStore: AgentProfileStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  database: Database;
  authoriseQuestion: (question: PersonQuestion) => Promise<void>;
  routineIntelligence: Pick<IntelligenceLike, "getThreadMessages">;
  approvalComputerTools: (
    ownerUserId: string,
    agentId: string,
    initiator: AuditInitiator,
  ) => Promise<HeadlessTool[]>;
  review: ReviewModel;
  notify: (
    scope: DeliveryScope,
    input: { id: string; kind: "approval"; requestId: string; text: string },
  ) => Promise<void>;
}) {
  const {
    storedApprovals,
    config,
    sourceForCoordinationRun,
    agentProfileStore,
    actorFor,
    database,
    authoriseQuestion,
    routineIntelligence,
    approvalComputerTools,
  } = deps;
  return createApprovalService(
    {
      ...storedApprovals,
      open: async (action) => {
        const request = await storedApprovals.open(action);
        if (request.status === "pending") {
          const forwarded = action.continuation?.forwardedProps;
          const signed =
            forwarded &&
            typeof forwarded === "object" &&
            "openbotRun" in forwarded
              ? readRunAssertion(forwarded.openbotRun, config.keyEncryptionKey)
              : null;
          const run =
            signed &&
            signed.actorId === action.actorId &&
            signed.botId === action.botId
              ? signed
              : {
                  actorId: action.actorId,
                  botId: action.botId,
                  runId: action.runId,
                  threadId: action.threadId,
                  depth: 0,
                };
          const source = await sourceForCoordinationRun(run);
          const botName = source
            ? ((
                await agentProfileStore
                  .get(await actorFor(action.actorId), action.botId)
                  .catch(() => null)
              )?.name ?? action.botId)
            : action.botId;
          if (source && run.threadId)
            await deps.notify(
              {
                ownerUserId: action.actorId,
                channelId: source.channelId,
                agentId: source.botId,
                threadId: run.threadId,
              },
              {
                id: request.id,
                kind: "approval",
                requestId: request.id,
                text: `${botName} asks for approval to use ${action.toolRef}. Open the Bot's page in OpenBot to review this action.`,
              },
            );
        }
        return request;
      },
    },
    createApprovalQuestions(database, authoriseQuestion),
    async (ownerUserId, botId, snapshot) => {
      const source = await sourceForCoordinationRun({
        actorId: ownerUserId,
        botId,
        threadId: snapshot.threadId,
        runId: snapshot.runId,
        depth: 0,
        initiator: PERSON_INITIATOR,
      });
      if (!source)
        throw new ApprovalRefusedError(
          "That conversation is no longer available to this Bot and person.",
        );
      const saved = await savedToolCall(
        () =>
          routineIntelligence.getThreadMessages({
            threadId: snapshot.threadId,
            userId: ownerUserId,
          }),
        snapshot,
      );
      if (!saved.matches || saved.answered)
        throw new ApprovalRefusedError(
          "That unanswered tool call is not saved in this conversation.",
        );
      const tools = await approvalComputerTools(
        ownerUserId,
        botId,
        PERSON_INITIATOR,
      );
      const tool = tools.find(
        (tool) => tool.definition.name === snapshot.toolName,
      );
      if (!tool)
        throw new ApprovalRefusedError("That computer tool is not available.");
      return tool.execute(snapshot.args, {
        toolCallId: snapshot.toolCallId,
        signal: new AbortController().signal,
      });
    },
    { review: deps.review },
  );
}
