import { randomUUID } from "node:crypto";
import { IntelligenceAgentRunner } from "@copilotkit/runtime/v2";
import { workOwner } from "@openbot/shared/work-owner";
import { eq } from "drizzle-orm";
import { type AuditStore, handoffInitiator } from "../audit";
import type { GroupConversations } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { ThreadIdentity } from "../channels/thread-identity";
import type { DeploymentConfig } from "../config";
import type { mountCopilotRuntime } from "../copilot";
import type { Database } from "../db/client";
import { intelligenceChannelMappings } from "../db/schema";
import { repeatAfterEach } from "../work/loop";
import {
  createWorkQueue,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "../work/queue";
import { HANDOFF_KIND } from "./handoff";
import { createHandoffDelivery } from "./handoff-delivery";
import { createHandoffRunner } from "./handoff-runner";
import { signHandoffDeliveryRun } from "./handoff-signing";
import type { AgentActor } from "./profile-types";
import { serverTurnAdmission } from "./turn-admission";

/**
 * Handing work between Bots, started on this replica: the runner that claims hops, the delivery
 * that runs the addressed Bot, and the loop and queue wake-up that drive them.
 *
 * Moved out of index.ts verbatim. Returns the queue's wake-up listener, which index.ts holds so its
 * shutdown can give the connection back. Called only where handing work between Bots is on.
 */
export async function startHandoffDelivery(deps: {
  config: DeploymentConfig;
  database: Database;
  bootAuditStore: AuditStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  copilotRuntime: ReturnType<typeof mountCopilotRuntime>;
  threadIdentity: ThreadIdentity;
  groupConversations: GroupConversations;
  channelStore: ChannelStore;
}): Promise<WorkOfferedListener> {
  const {
    config,
    database,
    bootAuditStore,
    actorFor,
    copilotRuntime,
    threadIdentity,
    groupConversations,
    channelStore,
  } = deps;
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, config.keyEncryptionKey, undefined, claim),
    // The asking conversation, told what it is waiting on once the queue has moved for a hop.
    onSettled: (work) => channelStore.signalWork(work.threadId),
    delivery: createHandoffDelivery({
      admission: serverTurnAdmission,
      /*
       * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
       * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
       * agreed to, and the person was told it never answered.
       */
      agentFor: async ({ actorId, botId, fromBotId, initiator }) => {
        const actor = await actorFor(actorId).catch(() => null);
        if (!actor) {
          throw new Error(
            "who this is for could not be confirmed, so the Bot was not run",
          );
        }
        return copilotRuntime.agentFor({
          actor,
          botId,
          initiator: handoffInitiator(fromBotId, initiator),
        });
      },
      history: copilotRuntime.history,
      lock: copilotRuntime.threadLock,
      /*
       * A scratch thread of the addressed Bot's own, one per hop.
       *
       * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
       * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
       * what it said comes back to the conversation that asked through the relay — in the asking
       * Bot's voice, which is the only voice that thread admits. Minted with the deployment's own
       * identity, like every thread this deployment starts.
       */
      mintThreadId: () => threadIdentity.mint(),
      /*
       * The roster, told that a relayed answer landed. The delivery knows only the thread it ran
       * in; this resolves which channel shows that thread — a scratch thread maps to nothing and
       * announces nowhere, which is the point of a scratch thread.
       */
      announce: async (input) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, input.threadId))
          .limit(1);
        // A Bot's group thread maps to no channel; its answer goes to the shared transcript.
        if (!mapped) {
          await groupConversations.announceHandoff(input);
          return;
        }
        const actor = await actorFor(input.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text: input.text,
          agentId: input.agentId,
          at: new Date(),
        });
      },
      // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
      // to its channel by the store; a scratch thread maps to none and signals nowhere.
      setBusy: (input) => channelStore.signalBusy(input.threadId, input.busy),
      newRunId: () => randomUUID(),
      // The same address and the same token the runtime uses. Assembling either from configuration
      // produced a runner every join was refused for, because the thread's active run is a lock the
      // platform issues rather than something an API key can claim.
      runner: new IntelligenceAgentRunner(
        copilotRuntime.runnerConnection(),
      ) as never,
    }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      console.warn(
        "[handoff] a sweep could not run:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  const listener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
  return listener;
}
