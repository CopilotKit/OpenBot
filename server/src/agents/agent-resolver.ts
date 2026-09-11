import type { AbstractAgent } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import {
  type HandoffForRun,
  type LoadAgentsForActor,
  type LoadInstructions,
  type LoadToolsForBot,
  type RuntimeModel,
  resolveRuntimeAgents,
  type SignRun,
  type ToolSelection,
} from "../copilot";
import type { AgentActor } from "./profile-types";

export type ActorAgentResolver = {
  resolveAgentsForActor(
    actor: AgentActor,
  ): Promise<Record<string, AbstractAgent>>;
  /**
   * One coworker, and what started the run it is for.
   *
   * The initiator is the caller's statement about the run rather than about the person: a routine's
   * firing, or a hop delivered to another Bot. It reaches the grants read and the run assertion, so
   * the audit row says what caused the call and not only whose authority it borrowed. Absent means a
   * person asked, which is what a browser turn is.
   */
  resolveAgentForActor(
    actor: AgentActor,
    agentId: string,
    initiator?: AuditInitiator,
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
  signRunForActor?: (actorId: string, initiator?: AuditInitiator) => SignRun;
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
  handoffForActor?: (actorId: string) => HandoffForRun;
  /**
   * What the person asking has told every built-in coworker they run, resolved for whoever is
   * asking.
   *
   * Per actor, and read through the actor this boundary was handed rather than anything in a
   * request body, for the same reason the grants are: this text goes into a prompt that then speaks
   * as that person's coworker, so which person it belongs to has to be decided by the session and
   * never by the caller.
   */
  loadInstructionsForActor?: (actorId: string) => LoadInstructions;
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
    /** What started this run, when something other than a person did. See {@link ActorAgentResolver}. */
    initiator?: AuditInitiator,
  ) =>
    resolveRuntimeAgents(
      () => Promise.resolve(registered),
      deps.model,
      deps.resolveModelApiKey,
      deps.stallGuard,
      deps.loadToolsForActor?.(actor.id, initiator),
      deps.signRunForActor?.(actor.id, initiator),
      deps.computerGuidance,
      deps.loadVendors,
      deps.selectionForActor?.(actor.id),
      deps.agentFetch,
      deps.handoffForActor?.(actor.id),
      onlyAgentId,
      deps.loadInstructionsForActor?.(actor.id),
      initiator,
    );

  const resolveAgentsForActor = async (actor: AgentActor) =>
    resolveRegisteredAgents(actor, await deps.loadAgents(actor));

  return {
    resolveAgentsForActor,
    async resolveAgentForActor(actor, agentId, initiator) {
      const registered = await deps.loadAgents(actor);
      if (!registered.some((agent) => agent.id === agentId)) {
        throw new Error(`Coworker ${agentId} is unavailable to this user.`);
      }

      const agents = await resolveRegisteredAgents(
        actor,
        registered,
        agentId,
        initiator,
      );
      const agent = Object.hasOwn(agents, agentId)
        ? agents[agentId]
        : undefined;
      if (!agent) {
        throw new Error(`Coworker ${agentId} is unavailable to this user.`);
      }
      return agent;
    },
  };
}
