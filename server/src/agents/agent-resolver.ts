import type { AbstractAgent } from "@ag-ui/client";
import type { ComputerGuidance } from "@openbot/shared/bot-prompt";
import type { AuditInitiator } from "../audit";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import {
  type HandoffForRun,
  type LoadAgentsForActor,
  type LoadAttachment,
  type LoadInstructions,
  type LoadToolsForBot,
  type MarkAttachmentsSent,
  onOpenBotRunner,
  type RuntimeModel,
  resolveRuntimeAgents,
  type SignRun,
  type ToolSelection,
} from "../copilot";
import type { AcquireLearnedSkills } from "../learning/runtime";
import type { LoadPersonalMemory } from "../memory/tools";
import { NameContextMiddleware } from "../people/name-context";
import { isProactiveInitiator } from "../proactive/initiator";
import type { AgentActor } from "./profile-types";

export type AgentResolutionContext = {
  initiator?: AuditInitiator;
  depth?: number;
};

export class CoworkerUnavailableError extends Error {}

export type ActorAgentResolver = {
  resolveAgentsForActor(
    actor: AgentActor,
  ): Promise<Record<string, AbstractAgent>>;
  resolveAgentForActor(
    actor: AgentActor,
    agentId: string,
    context?: AgentResolutionContext,
  ): Promise<AbstractAgent>;
};

export type ActorAgentResolverDependencies = {
  loadNameForActor?: (actorId: string) => Promise<string | null>;
  loadAgents: LoadAgentsForActor;
  model: RuntimeModel;
  resolveModelApiKey: () => Promise<string | null>;
  stallGuard?: StallGuard;
  loadToolsForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
  ) => LoadToolsForBot;
  signRunForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    depth?: number,
  ) => SignRun;
  computerGuidance?: ComputerGuidance;
  loadVendors?: () => Promise<readonly string[]>;
  selectionForActor?: (actorId: string) => ToolSelection;
  agentFetch?: AgentFetch;
  /**
   * What a Bot may reach past itself for, resolved for whoever is asking.
   *
   * Per actor for the same reason the tools are: which Bots may be reached is decided against the
   * roster that person can see, so a Bot must never be able to address one they cannot.
   */
  handoffForActor?: (
    actorId: string,
    initiator?: AuditInitiator,
    depth?: number,
  ) => HandoffForRun;
  loadInstructionsForActor?: (actorId: string) => LoadInstructions;
  loadAttachmentForActor?: (actorId: string) => LoadAttachment;
  markAttachmentsSentForActor?: (actorId: string) => MarkAttachmentsSent;
  acquireLearnedSkills?: AcquireLearnedSkills;
  loadPersonalMemoryForActor?: (actorId: string) => LoadPersonalMemory;
};

/**
 * Resolves the coworkers available to one OpenBot actor.
 *
 * Every surface enters through this boundary so it shares the same visibility, grants, assertions,
 * skill selection, and endpoint dial policy for a person.
 */
export function createActorAgentResolver(
  deps: ActorAgentResolverDependencies,
): ActorAgentResolver {
  const resolveRegisteredAgents = (
    actor: AgentActor,
    registered: Awaited<ReturnType<LoadAgentsForActor>>,
    /**
     * Build only this Bot, when the caller already knows which one it wants.
     *
     * The roster is still read in full, so a Bot this person cannot see is still absent. The others
     * are simply neither built nor asked what they hold, which is a query per Bot a headless turn
     * or a Slack thread has no use for.
     */
    onlyAgentId?: string,
    context?: AgentResolutionContext,
  ) => {
    /*
     * Learned Skills for this person's run: the Bot's own, plus the person's own Learning space and every Skill another
     * person opened (learning/runtime.ts). Bound here, where the person is known, so every path that builds a Bot for
     * them (a turn, a hop, a routine, a remote Bot) asks for the same set.
     */
    const acquire = deps.acquireLearnedSkills;
    const acquireForActor: AcquireLearnedSkills | undefined = acquire
      ? (agentId, signal) => acquire(agentId, signal, actor.id)
      : undefined;
    /*
     * A CHECK-IN RUNS EVERY BOT ON OPENBOT'S OWN RUNNER, and offers it everything it may read.
     *
     * A Bot on another framework is built as OpenBot would build it (`onOpenBotRunner`), so its own
     * endpoint, and any tool that endpoint holds out of OpenBot's sight, is never called while nobody
     * is watching. And its tools are not narrowed by skill: narrowing picks tools from the latest
     * message, which for a check-in is OpenBot's own instruction, and its reads are already only what
     * the person connected (`proactive/scope.ts`), so a narrowing could only drop an app.
     */
    const checkIn = isProactiveInitiator(context?.initiator);
    const runnable = checkIn ? registered.map(onOpenBotRunner) : registered;
    return resolveRuntimeAgents(
      () => Promise.resolve(runnable),
      deps.model,
      deps.resolveModelApiKey,
      deps.stallGuard,
      deps.loadToolsForActor?.(actor.id, context?.initiator),
      deps.signRunForActor?.(actor.id, context?.initiator, context?.depth),
      deps.computerGuidance,
      deps.loadVendors,
      checkIn ? undefined : deps.selectionForActor?.(actor.id),
      deps.agentFetch,
      deps.handoffForActor?.(actor.id, context?.initiator, context?.depth),
      onlyAgentId,
      deps.loadInstructionsForActor?.(actor.id),
      context?.initiator,
      deps.loadAttachmentForActor?.(actor.id),
      deps.markAttachmentsSentForActor?.(actor.id),
      acquireForActor,
      deps.loadPersonalMemoryForActor?.(actor.id),
    ).then((agents) => {
      const loadName = deps.loadNameForActor;
      if (loadName) {
        for (const registeredAgent of runnable) {
          if (registeredAgent.type !== "built_in") continue;
          agents[registeredAgent.id]?.use(
            new NameContextMiddleware(() => loadName(actor.id)),
          );
        }
      }
      return agents;
    });
  };

  const resolveAgentsForActor = async (actor: AgentActor) =>
    resolveRegisteredAgents(actor, await deps.loadAgents(actor));

  return {
    resolveAgentsForActor,
    async resolveAgentForActor(actor, agentId, context) {
      const registered = await deps.loadAgents(actor);
      if (!registered.some((agent) => agent.id === agentId)) {
        throw new CoworkerUnavailableError(
          `Coworker ${agentId} is unavailable to this user.`,
        );
      }

      const agents = await resolveRegisteredAgents(
        actor,
        registered,
        agentId,
        context,
      );
      const agent = Object.hasOwn(agents, agentId)
        ? agents[agentId]
        : undefined;
      if (!agent) {
        throw new CoworkerUnavailableError(
          `Coworker ${agentId} is unavailable to this user.`,
        );
      }
      return agent;
    },
  };
}
