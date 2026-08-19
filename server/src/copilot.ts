import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  BuiltInAgent,
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import type { AgentActor } from "./agents/profile-types";
import type { StallGuard } from "./channels/stall-guard";
import type { DeploymentConfig } from "./config";

/**
 * The CopilotKit runtime, always in Intelligence mode.
 *
 * Package-declared built-in Bots run as CopilotKit `BuiltInAgent` instances. External Bots are
 * reached over AG-UI as `HttpAgent` instances, so anything that speaks the protocol remains a Bot
 * with no framework adapter here: LangGraph, Pydantic-AI, CrewAI, Mastra, ADK, or a hand-written
 * server.
 *
 * There is no SSE branch. Intelligence is a requirement of the product, not a tier: it owns
 * durable threads, memory and learning, and a deployment without it silently forgets every
 * conversation. config.ts refuses to boot without the full contract, so by the time this runs the
 * settings are present and this file has one mode.
 */

/** Resolve the signed-in person for a request. Threads and memory are scoped to whoever this returns. */
export type IdentifyUser = (
  request: Request,
) => Promise<{ id: string; name: string }>;

type RegisteredBuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  systemPrompt: string;
};

type RegisteredRemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
  standingMessage: StandingRoleMessage;
  /** The key this agent sits behind, resolved from the vault at load time. Never logged. */
  headers?: Record<string, string>;
};

/**
 * A coworker the caller may see but may not run: its profile was deleted while a channel it worked
 * in still exists. It is registered so Intelligence can restore that thread and the person can read
 * what was said; every run is refused here, without contacting the endpoint.
 */
type RegisteredUnavailableAgent = {
  id: string;
  name: string;
  type: "unavailable";
  reason: string;
};

export type RegisteredAgent =
  | RegisteredBuiltInAgent
  | RegisteredRemoteAgent
  | RegisteredUnavailableAgent;

type AgentRunInput = Parameters<AbstractAgent["run"]>[0];
type AgentMessage = AgentRunInput["messages"][number];
export type StandingRoleMessage = Extract<AgentMessage, { role: "system" }>;

/** The durable part of a coworker: who it is and what its standing job is. */
export type AgentStandingProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
};

/**
 * The coworker's job, as one system message.
 *
 * It is an ordinary AG-UI system message rather than `forwardedProps` or framework-specific state
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server, and
 * a system message is the only thing all of them already understand. The id is derived from the
 * agent so a run can recognise a copy of it and refuse to send a second.
 */
export function standingRoleMessage(
  profile: AgentStandingProfile,
): StandingRoleMessage {
  return {
    id: `standing-role:${profile.id}`,
    role: "system",
    content: [
      `You are ${profile.name}, ${profile.title}.`,
      profile.roleDescription,
      "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
    ].join("\n\n"),
  };
}

export type RuntimeModel = {
  provider: "openai";
  defaultModel: string;
};

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui";
  configuration: unknown;
  title: string;
  roleDescription: string;
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  const configuration = row.configuration;
  if (row.type === "built_in") {
    const systemPrompt = configuration?.systemPrompt;
    const trimmedSystemPrompt =
      typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    return trimmedSystemPrompt.length > 0
      ? {
          id: row.id,
          name: row.name,
          type: "built_in",
          systemPrompt: trimmedSystemPrompt,
        }
      : null;
  }

  const endpoint = configuration?.endpoint;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: "remote_ag_ui",
        endpoint,
        standingMessage: standingRoleMessage(row),
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function builtInAgentConfiguration(
  agent: RegisteredBuiltInAgent,
  model: RuntimeModel,
  apiKey: string | null,
): BuiltInAgentConfiguration {
  if (!apiKey) {
    return {
      type: "custom",
      // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
      factory: async function* () {
        throw new Error(
          `Model credential is not configured for ${agent.name}. Add the package credential or set OPENAI_API_KEY.`,
        );
      },
    };
  }

  return {
    model: `${model.provider}/${model.defaultModel}`,
    prompt: agent.systemPrompt,
    apiKey,
  };
}

/**
 * Build the built-in and remote AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  apiKey: string | null,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
): Record<string, AbstractAgent> {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.id,
      buildAgent(agent, model, apiKey, stallGuard),
    ]),
  );
}

function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  apiKey: string | null,
  stallGuard?: StallGuard,
): AbstractAgent {
  if (agent.type === "built_in") {
    return new BuiltInAgent(builtInAgentConfiguration(agent, model, apiKey));
  }
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  return remoteAgentWithStandingRole(agent, stallGuard);
}

/**
 * A remote AG-UI agent that states its standing role on every run.
 *
 * This is standard AG-UI middleware rather than a request transformation on one provider's client,
 * so the same coworker works against any endpoint that speaks the protocol. Any copy of the standing
 * message already in the conversation is dropped: the endpoint must receive exactly one, first,
 * however many times the thread has been replayed.
 *
 * The stall watch goes on the fetch rather than into that middleware, because the middleware works
 * in AG-UI events and a stall is the absence of one. The thing that has to be watched is the
 * response body, and the fetch is where this deployment still holds it.
 */
function remoteAgentWithStandingRole(
  agent: RegisteredRemoteAgent,
  stallGuard?: StallGuard,
) {
  const remote = new HttpAgent({
    url: agent.endpoint,
    agentId: agent.id,
    // The customer's own key, if their agent sits behind one. `HttpAgentConfig` is
    // `{ url, headers?, fetch? }`, verified against @ag-ui/client 0.0.57.
    ...(agent.headers ? { headers: agent.headers } : {}),
    ...(stallGuard
      ? { fetch: stallGuard.watch({ id: agent.id, name: agent.name }) }
      : {}),
  });
  remote.use((input, next) =>
    next.run({
      ...input,
      messages: [
        agent.standingMessage,
        ...input.messages.filter(
          (message) => message.id !== agent.standingMessage.id,
        ),
      ],
    }),
  );
  return remote;
}

class UnavailableAgent extends AbstractAgent {
  private readonly reason: string;

  constructor(agent: RegisteredUnavailableAgent) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

export async function resolveRuntimeAgents(
  loadAgents: () => Promise<RegisteredAgent[]>,
  model: RuntimeModel,
  resolveModelApiKey: () => Promise<string | null>,
  stallGuard?: StallGuard,
): Promise<Record<string, AbstractAgent>> {
  const registered = await loadAgents();
  if (registered.length === 0) {
    throw new Error(
      "No agents are registered. Add one to the tenant package or the agents table.",
    );
  }

  const apiKey = registered.some((agent) => agent.type === "built_in")
    ? await resolveModelApiKey()
    : null;
  return buildAgents(registered, model, apiKey, stallGuard);
}

/** Who is asking. Agent visibility is decided per person, so a run has to know this first. */
export type IdentifyActor = (request: Request) => Promise<AgentActor>;

/** Loads exactly the agents one person may see, already carrying their standing roles. */
export type LoadAgentsForActor = (
  actor: AgentActor,
) => Promise<RegisteredAgent[]>;

/**
 * Build the runtime's per-request agent factory.
 *
 * Resolution is per request, not per boot, because who may run a coworker is a property of the
 * person asking: a private coworker must be absent for everybody else, and a role edited a moment
 * ago must apply to the next run without a restart. Both fall out of rebuilding the map here.
 */
export function createRequestAgents(
  identifyActor: IdentifyActor,
  loadAgents: LoadAgentsForActor,
  model: RuntimeModel,
  resolveModelApiKey: () => Promise<string | null>,
  /**
   * Shared across every request rather than built per run, because it is the thing that has to
   * outlive one: the sweep that notices a silent stream has to still be running after the request
   * that opened it has been answered.
   */
  stallGuard?: StallGuard,
) {
  return async ({ request }: { request: Request }) => {
    const actor = await identifyActor(request);
    return resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
    );
  };
}

/**
 * Mount the CopilotKit endpoint onto the host Hono app.
 *
 * `agents` is a factory rather than a fixed map so a Bot registered while the server is running is
 * reachable on the next request. Resolving once at boot would mean every new Bot needed a restart,
 * which is not a property you can explain to somebody who just created one.
 */
export function mountCopilotRuntime(
  config: DeploymentConfig,
  model: RuntimeModel,
  loadAgents: LoadAgentsForActor,
  resolveModelApiKey: () => Promise<string | null>,
  identifyUser: IdentifyUser,
  identifyActor: IdentifyActor,
  /**
   * The watch on Bot streams. Not optional, unlike the parameter it forwards to: a guard built from
   * a timeout of zero already watches nothing, so an unconfigured deployment has one to hand and
   * there is no reason for a caller to have to say `undefined` here to reach `basePath`.
   */
  stallGuard: StallGuard,
  basePath = "/api/copilotkit",
) {
  const { intelligence } = config.runtime;

  const runtime = new CopilotRuntime({
    // `mode` is inferred from the presence of `intelligence`; passing it is a type error.
    //
    // identifyUser is NOT optional in practice. Threads and memory are scoped to the user it
    // returns, so omitting it puts every person in the deployment in the same thread space and one
    // person's conversations become another's.
    identifyUser,
    intelligence: new CopilotKitIntelligence({
      apiUrl: intelligence.apiUrl,
      wsUrl: intelligence.gatewayWsUrl,
      apiKey: intelligence.apiKey,
    }),
    licenseToken: intelligence.licenseToken,
    // `identifyUser` is the Intelligence projection of the same person `identifyActor` returns:
    // one resolver decides both whose threads these are and whose coworkers exist.
    agents: createRequestAgents(
      identifyActor,
      loadAgents,
      model,
      resolveModelApiKey,
      stallGuard,
    ) as never,
  });

  return createCopilotHonoHandler({ runtime, basePath });
}
