import { buildResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import type { ComponentCatalog } from "@openbot/toolkit/ports";
import {
  createTurnRunner,
  type IntelligenceLike,
  type RunnerLike,
} from "@openbot/toolkit/run-turn";
import { z } from "zod";
import { canUseComputer } from "../agents/computer-access";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { serverTurnAdmission } from "../agents/turn-admission";
import {
  parseApprovalContinuation,
  parseApprovalResult,
} from "../approvals/types";
import type { AuditInitiator, AuditStore } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { ComputerGateway } from "../computer/gateway";
import { createHeadlessComputerTools } from "../computer/headless-tools";
import type { mountCopilotRuntime } from "../copilot";
import type { Database } from "../db/client";
import type { DeliveryScope } from "../delivery/types";
import { markUntrusted } from "../untrusted-content";
import { createWorkQueue } from "../work/queue";
import {
  createResponsibilityEngine,
  type ResponsibilityEngine,
} from "./engine";
import { responsibilityTools } from "./tools";
import type { ResponsibilityStore } from "./types";

/**
 * The deployment's responsibility engine: a responsibility's turn, with the computer when the Bot
 * may use it and the responsibility's own tools, and its reply posted to the channel it watches.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because delivery is assigned after
 * this is created, and a reply reads it when it is posted, never when this is built.
 */
export function createServerResponsibilityEngine(deps: {
  database: Database;
  responsibilityStore: ResponsibilityStore;
  routineIntelligence: IntelligenceLike;
  routineAgentRunner: RunnerLike;
  componentCatalog: ComponentCatalog;
  buildAgentFor: Parameters<typeof createTurnRunner>[0]["buildAgentFor"];
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  computerGateway: ComputerGateway | undefined;
  agentProfileStore: AgentProfileStore;
  bootAuditStore: AuditStore;
  signInService: Parameters<typeof createHeadlessComputerTools>[0]["signIn"];
  copilotRuntime: Pick<ReturnType<typeof mountCopilotRuntime>, "learning">;
  channelStore: ChannelStore;
  notify: (
    scope: DeliveryScope,
    input: { id: string; kind: "reply"; text: string },
  ) => Promise<void>;
}): ResponsibilityEngine {
  const {
    database,
    responsibilityStore,
    routineIntelligence,
    routineAgentRunner,
    componentCatalog,
    buildAgentFor,
    actorFor,
    computerGateway,
    agentProfileStore,
    bootAuditStore,
    signInService,
    copilotRuntime,
    channelStore,
  } = deps;
  const responsibilityQueue = createWorkQueue(database);
  const responsibilityEngine: ResponsibilityEngine = createResponsibilityEngine(
    {
      store: responsibilityStore,
      queue: responsibilityQueue,
      runTurn: async (context) => {
        const initiator: AuditInitiator = {
          kind: "responsibility",
          id: context.responsibilityId,
        };
        const tools = responsibilityTools({
          store: responsibilityStore,
          engine: responsibilityEngine,
          ownerUserId: context.ownerUserId,
          agentId: context.agentId,
          channelId: context.channelId,
          responsibilityRunId: context.runId,
        });
        const runner = createTurnRunner({
          admission: serverTurnAdmission,
          intelligence: routineIntelligence,
          runner: routineAgentRunner,
          components: componentCatalog,
          buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
          toolsForTurn: async () => {
            const actor = await actorFor(context.ownerUserId);
            // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
            const computer =
              computerGateway &&
              canUseComputer(
                await agentProfileStore
                  .get(actor, context.agentId)
                  .catch(() => null),
                actor,
              )
                ? createHeadlessComputerTools({
                    gateway: computerGateway,
                    seat: await computerGateway.seatFor(
                      context.agentId,
                      actor.id,
                    ),
                    actor: { id: actor.id, userId: actor.id, initiator },
                    auditStore: bootAuditStore,
                    ...(signInService ? { signIn: signInService } : {}),
                  })
                : [];
            return [
              ...computer,
              ...tools.map((tool) => ({
                definition: {
                  name: tool.name,
                  description: tool.description,
                  parameters: z.toJSONSchema(tool.parameters),
                },
                execute: (args: unknown) => tool.execute(args),
              })),
            ];
          },
          learningContainerForThread: (input) =>
            copilotRuntime.learning?.containerForThread(input) ??
            Promise.resolve(undefined),
        });
        const saved = context.continuation;
        const snapshot = saved
          ? parseApprovalContinuation(saved.waiting.continuation)
          : undefined;
        const toolResult = saved
          ? parseApprovalResult(saved.response)
          : undefined;
        return runner({
          ownerUserId: context.ownerUserId,
          routineId: context.responsibilityId,
          agentId: context.agentId,
          threadId: context.threadId,
          initiator,
          signal: context.signal,
          ...(snapshot && toolResult
            ? {
                continuation: {
                  snapshot,
                  result: toolResult,
                  messageId: `responsibility-result:${context.runId}:${snapshot.toolCallId}`,
                },
              }
            : {}),
          instruction: buildResponsibilityTurn({
            instruction: context.instruction,
            successCriteria: context.successCriteria,
            progress: context.progress,
            trigger: context.event,
            eventData: markUntrusted(
              JSON.stringify(context.event.payload),
              `${context.event.source} event`,
            ),
            responsibilityId: context.responsibilityId,
          }),
        });
      },
      onReply: async (context, text) => {
        await channelStore.recordActivity(
          await actorFor(context.ownerUserId),
          context.channelId,
          { text, agentId: context.agentId, at: new Date() },
          { id: `responsibility:${context.runId}` },
        );
        await deps.notify(
          {
            ownerUserId: context.ownerUserId,
            channelId: context.channelId,
            agentId: context.agentId,
            threadId: context.threadId,
          },
          { id: `responsibility:${context.runId}`, kind: "reply", text },
        );
      },
    },
  );
  return responsibilityEngine;
}
