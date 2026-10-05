import type { AbstractAgent } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import {
  type HandoffForRun,
  type LoadAgentsForActor,
  type LoadAttachment,
  type LoadInstructions,
  type LoadToolsForBot,
  type MarkAttachmentsSent,
  type RuntimeModel,
  resolveRuntimeAgents,
  type SignRun,
  type ToolSelection,
} from "../copilot";
import type { AcquireLearnedSkills } from "../learning/runtime";
import type { LoadPersonalMemory } from "../memory/tools";
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
  computerGuidance?: string;
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
  ) =>
    resolveRuntimeAgents(
      () => Promise.resolve(registered),
      deps.model,
      deps.resolveModelApiKey,
      deps.stallGuard,
      deps.loadToolsForActor?.(actor.id, context?.initiator),
      deps.signRunForActor?.(actor.id, context?.initiator, context?.depth),
      deps.computerGuidance,
      deps.loadVendors,
      deps.selectionForActor?.(actor.id),
      deps.agentFetch,
      deps.handoffForActor?.(actor.id, context?.initiator, context?.depth),
      onlyAgentId,
      deps.loadInstructionsForActor?.(actor.id),
      context?.initiator,
      deps.loadAttachmentForActor?.(actor.id),
      deps.markAttachmentsSentForActor?.(actor.id),
      deps.acquireLearnedSkills,
      deps.loadPersonalMemoryForActor?.(actor.id),
    );

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
