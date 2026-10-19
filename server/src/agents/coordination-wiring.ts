import { createHash } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { eq } from "drizzle-orm";
import { PERSON_QUESTION_WAITING } from "../approvals/question-resume";
import type { ApprovalService } from "../approvals/service";
import { currentApprovalContext } from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  PERSON_INITIATOR,
} from "../audit";
import { groupSourceForRun } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { channelMemberships } from "../db/schema";
import type { DeliveryScope } from "../delivery/types";
import type { PeopleStore } from "../people/store";
import type { PluginStore } from "../plugins/store";
import { REFUSAL_MARKER } from "../plugins/tools";
import { createPrivateShareCheck } from "../proactive/private-share";
import { createWorkQueue } from "../work/queue";
import { type RunAssertion, readRunAssertion } from "./callback-token";
import type { HandoffDesk } from "./handoff";
import {
  authoriseCoordinationRun,
  createCoordinationTools,
  readCoordinationHandoffClaim,
} from "./handoff-tool";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

/**
 * Bots coordinating with each other and with people: handing work on, asking a person a question,
 * and the per-run tools a Bot is given for both.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because index.ts assigns delivery
 * after this is created: a question reads it when it is routed, never when this is built.
 */
export function wireCoordination(deps: {
  handoffDesk: HandoffDesk;
  config: DeploymentConfig;
  approvalService: ApprovalService;
  agentProfileStore: AgentProfileStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  channelSourceForRun: (
    run: RunAssertion,
  ) => Promise<{ channelId: string; botId: string } | null>;
  database: Database;
  pluginStore: PluginStore;
  bootAuditStore: AuditStore;
  peopleStore: PeopleStore;
  sourceForCoordinationRun: (
    run: RunAssertion,
  ) => Promise<{ channelId: string; botId: string } | null>;
  channelStore: ChannelStore;
  notify: (
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: "question";
      requestId: string;
    },
  ) => Promise<void>;
}) {
  const {
    handoffDesk,
    config,
    approvalService,
    agentProfileStore,
    actorFor,
    channelSourceForRun,
    database,
    pluginStore,
    bootAuditStore,
    peopleStore,
    sourceForCoordinationRun,
    channelStore,
  } = deps;
  const personQuestions = createWorkQueue(database);
  const coordination = createCoordinationTools({
    desk: handoffDesk,
    caps: config.handoff,
    approvalGate: approvalService.gate,
    privateShare: {
      check: createPrivateShareCheck({ approvals: approvalService.store }),
      // Resolved the way the desk resolves it: an id wins, then a single visible name. Null for the
      // owner's own Bot or a deployment Bot, since nobody else reads that work.
      audienceFor: async (from, target) => {
        const roster = await agentProfileStore.list(
          await actorFor(from.actorId),
        );
        const wanted = target.trim().toLowerCase();
        const found =
          roster.find((candidate) => candidate.id.toLowerCase() === wanted) ??
          roster.find(
            (candidate) =>
              !candidate.hidden &&
              candidate.deletedAt === null &&
              candidate.name.toLowerCase() === wanted,
          );
        if (!found?.ownerUserId || found.ownerUserId === from.actorId)
          return null;
        return {
          kind: "handoff",
          id: found.ownerUserId,
          recipientUserIds: [found.ownerUserId],
          label: found.name,
        };
      },
      // A question from a conversation other people are in reaches them too, so it is held like a
      // handoff to another person. Only the owner reading it is the ordinary, unheld case.
      questionAudience: async (from) => {
        const channel = await channelSourceForRun(from);
        const group = channel ? null : await groupSourceForRun(database, from);
        const source = channel ?? group;
        if (!source) return null;
        const members = (
          await database
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, source.channelId))
        ).map((row) => row.userId);
        if (members.every((userId) => userId === from.actorId)) return null;
        return {
          audience: {
            kind: group ? "group" : "channel",
            id: source.channelId,
            recipientUserIds: members,
          },
          // A channel thread is the conversation itself; a group Bot's own thread also holds context
          // only its owner has seen.
          origin: channel
            ? { kind: "shared_conversation", sharedWithUserIds: members }
            : { kind: "private_conversation" },
        };
      },
    },
    botsReachableFrom: (botId) => pluginStore.botsReachableFrom(botId),
    auditStore: bootAuditStore,
    authoriseRun: (run) =>
      authoriseCoordinationRun(run, {
        canUseBot: async (scope) => {
          const person = await peopleStore.find(scope.actorId);
          if (!person || person.revoked) return false;
          return (
            (await agentProfileStore.get(
              await actorFor(scope.actorId),
              scope.botId,
            )) !== null
          );
        },
        sourceThread: sourceForCoordinationRun,
        delegationFor: (claim) => readCoordinationHandoffClaim(database, claim),
      }),
    route: async (question) => {
      const source = await sourceForCoordinationRun(question);
      if (!source)
        return {
          refusal: "That question could not reach its source conversation.",
        };
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            question.actorId,
            question.botId,
            question.runId,
            question.question,
          ]),
        )
        .digest("hex");
      const queued = await personQuestions.offer({
        kind: "person.question",
        key,
        payload: {
          ...question,
          sourceBotId: source.botId,
          channelId: source.channelId,
          mode: "completed_question",
          toolName: "ask_person",
          args: {
            question: question.question,
            ...(question.why ? { why: question.why } : {}),
          },
        },
      });
      if (queued === "refused")
        return { refusal: "The question could not be saved for its person." };
      await channelStore.recordActivity(
        await actorFor(question.actorId),
        source.channelId,
        {
          text: `A question needs your answer: ${question.question}`,
          agentId: source.botId,
          at: new Date(),
        },
        { id: `question:${key}` },
      );
      if (question.threadId) {
        // A person reads this in Slack or on their phone, where "general-assistant" is an id, not a name.
        const botName =
          (
            await agentProfileStore
              .get(await actorFor(question.actorId), question.botId)
              .catch(() => null)
          )?.name ?? question.botId;
        await deps.notify(
          {
            ownerUserId: question.actorId,
            channelId: source.channelId,
            agentId: source.botId,
            threadId: question.threadId,
          },
          {
            id: key,
            text: `${botName} asks: ${question.question}`,
            kind: "question",
            requestId: key,
          },
        );
      }
      return {
        reached:
          "the person in the source conversation; the question is saved awaiting their reply",
      };
    },
  });
  const coordinationForActor =
    (
      actorId: string,
      initiator: AuditInitiator = PERSON_INITIATOR,
      baseDepth = 0,
    ) =>
    async (botId: string, input: import("@ag-ui/client").RunAgentInput) => {
      const assertion = readRunAssertion(
        input.forwardedProps?.openbotRun,
        config.keyEncryptionKey,
      );
      if (
        assertion &&
        (assertion.botId !== botId || assertion.actorId !== actorId)
      )
        throw new Error("The run assertion does not match this Bot and owner.");
      const run: RunAssertion = assertion?.handoff
        ? assertion
        : {
            botId,
            actorId,
            runId: input.runId,
            threadId: input.threadId,
            depth: assertion?.depth ?? baseDepth,
            initiator: assertion?.initiator ?? initiator,
          };
      const tools = await coordination.toolsForRun(run);
      return tools.map((tool) => ({
        ...tool,
        execute: async (args: unknown) => {
          if (!args || typeof args !== "object" || Array.isArray(args))
            return `${REFUSAL_MARKER} Tool arguments must be an object.`;
          const result = await coordination.call({
            name: tool.name,
            args: args as Record<string, unknown>,
            run,
          });
          if (!result)
            throw new Error("A coordination tool was not dispatched.");
          /*
           * A responsibility's question pauses its run, the way an approval does.
           *
           * Left running, the run ended "succeeded" the moment the question was saved, and the answer
           * came back to a run that was already over: the Bot read it, and then the store refused its
           * progress because it was not from the responsibility's current run, so the goal stayed
           * open for ever. Suspended, the run waits, and the answer resumes that same run as this
           * tool's result, with the right to record progress and finish.
           */
          const snapshot = currentApprovalContext();
          if (
            tool.name === "ask_person" &&
            run.initiator?.kind === "responsibility" &&
            snapshot &&
            !result.text.startsWith(REFUSAL_MARKER)
          )
            throw new HeadlessToolSuspension(
              "This responsibility is waiting for the person's answer.",
              {
                kind: PERSON_QUESTION_WAITING,
                continuation: snapshot,
              },
            );
          return result.text;
        },
      }));
    };
  return { coordination, coordinationForActor };
}
