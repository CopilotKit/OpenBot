import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  BuiltInAgent,
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { z } from "zod";
import {
  COMPUTER_GUIDANCE,
  PROVENANCE_GUIDANCE,
} from "../../shared/bot-prompt";
import type { AgentActor } from "./agents/profile-types";
import type { StallGuard } from "./channels/stall-guard";
import type { DeploymentConfig } from "./config";
import type { GrantedTool } from "./plugins/tools";
import { grantedToolGuidance } from "./plugins/tools";

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
      /*
       * Here rather than in the package, because for a remote Bot the standing role is the only
       * instruction there is: `role_description` is one sentence somebody wrote about what it is
       * for, and nothing else reaches it. The compliance Bot that answered a filing question with
       * thresholds and deadlines and no source was a `remote-ag-ui` agent whose entire prompt was
       * "Investigate policies, transaction monitoring, and control evidence."
       */
      PROVENANCE_GUIDANCE,
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
  /**
   * What this Bot may call, resolved for the person asking.
   *
   * Handed to the agent rather than registered by the surface, so a run needs no browser. These are
   * not raw MCP servers on purpose: each one executes through the plugin store, which checks the
   * grant, evaluates the policy and writes the audit row. Passing `mcpServers` here instead would
   * let the agent reach a vendor directly and walk around all three.
   */
  tools: GrantedTool[] = [],
  /**
   * What this Bot should know about the computer, when this deployment has one.
   *
   * Appended to the role rather than replacing it: the package says what the Bot is for, this says
   * what its hands are. Absent leaves the role alone, which is right for a deployment with no
   * computer configured, where the browser routes are not mounted and a Bot promised a browser would
   * be promising something that does not exist.
   */
  computerGuidance?: string,
  /**
   * Vendors this deployment connects to, whether or not this Bot holds any of their tools.
   *
   * A Bot holding nothing was told nothing, so it treated a connected vendor as an ordinary website
   * and browsed to it. See `grantedToolGuidance`.
   */
  connectedVendors: readonly string[] = [],
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
    /*
     * The package's role, then what this Bot actually holds, then the computer.
     *
     * The grants go BEFORE the computer prose on purpose. That prose is long and emphatic about the
     * browser and mentions connectors nowhere, so a Bot that read it last reached for the browser
     * even when it held a tool for the exact system being asked about.
     */
    prompt: [
      agent.systemPrompt,
      /*
       * Unconditional, unlike the two below it.
       *
       * Those describe things a deployment may or may not have. This describes how to answer at all,
       * and a Bot with no tools and no computer needs it most: it has nothing to read, so everything
       * it says comes from its own knowledge, and saying so is the only honest move available.
       */
      PROVENANCE_GUIDANCE,
      ...(grantedToolGuidance(tools, connectedVendors)
        ? [grantedToolGuidance(tools, connectedVendors)]
        : []),
      ...(computerGuidance ? [computerGuidance] : []),
    ].join("\n\n"),
    apiKey,
    /*
     * A run stops after one step unless told otherwise, which for a Bot with tools means it calls
     * one and never speaks: the tool executes, the result arrives, and the run ends before the model
     * can say what it found. The person sees their own question and nothing else.
     *
     * Only set when there are tools, because a Bot with none has nothing to continue for. The cap
     * bounds a model that would otherwise call tools in a circle. Interrupt tools, if any are ever
     * added here, require the default of one and must not be mixed in.
     */
    ...(tools.length > 0 ? { tools, maxSteps: TOOL_STEPS } : {}),
  };
}

/**
 * How many turns of the tool loop one run may take.
 *
 * Enough for a Bot to search, read what came back, search again on a better term, and answer.
 * Beyond that a model is not making progress, and every extra step is somebody's money.
 */
const TOOL_STEPS = 8;

/**
 * Build the built-in and remote AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export async function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  apiKey: string | null,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
  /** Absent leaves every Bot with no tools, which is the correct answer when nothing is granted. */
  loadTools: LoadToolsForBot = async () => [],
  signRun?: SignRun,
  /** What every built-in Bot is told about the computer. Absent means this deployment has none. */
  computerGuidance?: string,
  /**
   * Which vendors this deployment connects to. Asked once per build rather than per Bot, because it
   * is a fact about the deployment; what differs per Bot is which of them it holds.
   */
  loadVendors: () => Promise<readonly string[]> = async () => [],
): Promise<Record<string, AbstractAgent>> {
  const vendors = await loadVendors().catch(() => [] as readonly string[]);
  return Object.fromEntries(
    await Promise.all(
      agents.map(async (agent) => [
        agent.id,
        await buildAgent(
          agent,
          model,
          apiKey,
          stallGuard,
          loadTools,
          signRun,
          computerGuidance,
          vendors,
        ),
      ]),
    ),
  );
}

async function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  apiKey: string | null,
  stallGuard: StallGuard | undefined,
  loadTools: LoadToolsForBot,
  signRun?: SignRun,
  computerGuidance?: string,
  connectedVendors: readonly string[] = [],
): Promise<AbstractAgent> {
  if (agent.type === "built_in") {
    return new BuiltInAgent(
      builtInAgentConfiguration(
        agent,
        model,
        apiKey,
        await loadTools(agent.id),
        computerGuidance,
        connectedVendors,
      ),
    );
  }
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  return remoteAgentWithStandingRole(
    agent,
    stallGuard,
    await loadTools(agent.id),
    signRun,
    connectedVendors,
  );
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
  stallGuard: StallGuard | undefined,
  /**
   * What this Bot was granted, described rather than executable.
   *
   * A framework Bot runs its own loop and calls these back through `/api/agent-tools/call`, so what
   * it needs from here is the offer: the name, what the tool is for, and the arguments it takes.
   * The executing half stays on this side, where the grant and the policy are.
   */
  tools: GrantedTool[] = [],
  signRun?: SignRun,
  /** As for the built-in path: what this deployment connects to, held or not. */
  connectedVendors: readonly string[] = [],
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
  /*
   * What this Bot holds, as a second standing message.
   *
   * Beside the role rather than inside it, because the role comes from the package and this comes
   * from the grants: they change for different reasons and at different times. Sent on every run for
   * the same reason the tools are, so switching a connector on reaches the next run.
   *
   * The remote path needs this more than the built-in one, not less. A framework Bot is handed the
   * tools as an offer and decides for itself what to call, with `COMPUTER_GUIDANCE` as its whole
   * prompt — a page about the browser that mentions connectors nowhere. That is the Bot that browsed
   * to drive.google.com holding four Drive tools.
   */
  const holdings = grantedToolGuidance(tools, connectedVendors);
  const holdingsMessage = holdings
    ? {
        id: `granted-tools:${agent.id}`,
        role: "system" as const,
        content: holdings,
      }
    : null;

  remote.use((input, next) =>
    next.run({
      ...input,
      messages: [
        agent.standingMessage,
        ...(holdingsMessage ? [holdingsMessage] : []),
        ...input.messages.filter(
          (message) =>
            message.id !== agent.standingMessage.id &&
            message.id !== holdingsMessage?.id,
        ),
      ],
      /*
       * The Bot's own grants, added to whatever the surface offered.
       *
       * Sent on every run rather than configured once on the endpoint, because a grant an
       * administrator adds or revokes has to apply to the next run and the endpoint is somebody
       * else's process.
       */
      tools: [
        ...(input.tools ?? []),
        ...tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters) as Record<
            string,
            unknown
          >,
        })),
      ],
      // Who the Bot is calling back as, so the audit row names it rather than "an agent".
      forwardedProps: {
        ...(input.forwardedProps ?? {}),
        openbotBotId: agent.id,
        /*
         * Which of those tools this deployment runs, as opposed to the surface.
         *
         * `tools` mixes two kinds that a name cannot tell apart: the Bot's grants, which execute
         * here through the policy and the audit trail, and the components the browser draws. A Bot
         * that ran the second kind through this deployment asked it to execute a chart, was told it
         * could not, and then apologised to the person for not showing the chart that was on screen
         * in front of them. Only this side knows which is which, so only this side can say.
         */
        openbotDeploymentTools: tools.map((tool) => tool.name),
        /*
         * This deployment's own statement of what this run is.
         *
         * Signed, short-lived, and naming the Bot and the person. The agent hands it back when it
         * calls a tool, and that is where the Bot and the actor come from: its own token says which
         * agent is calling, and this says who it is calling for. Neither is taken from the request
         * body any more, which is what used to make the audit trail forgeable by anything holding
         * one shared secret.
         */
        ...(signRun
          ? { openbotRun: signRun(agent.id, input.runId) }
          : /*
             * Absent means this deployment cannot sign, so the agent is given nothing to hand back
             * and its tool calls will be refused. That is the right direction to fail: a Bot that
             * cannot prove whose run it is should not be spending anybody's grants.
             */
            {}),
      },
    } as never),
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
  loadTools?: LoadToolsForBot,
  signRun?: SignRun,
  computerGuidance?: string,
  loadVendors?: () => Promise<readonly string[]>,
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
  return buildAgents(
    registered,
    model,
    apiKey,
    stallGuard,
    loadTools,
    signRun,
    computerGuidance,
    loadVendors,
  );
}

/** What one Bot may call, for the person whose request this is. */
export type LoadToolsForBot = (botId: string) => Promise<GrantedTool[]>;

/**
 * The deployment's signed statement of what a run is, for the agent that will run it.
 *
 * A closure rather than a key passed down, so the encryption key stays in the module that owns
 * configuration and this one never holds a secret. Shaped like `LoadToolsForBot` on purpose: both are
 * per-actor facts resolved once per request and asked per Bot.
 */
export type SignRun = (botId: string, runId: string) => string;

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
  /** What each Bot may call, resolved for whoever is asking. Absent means no tools. */
  loadToolsForActor?: (actorId: string) => LoadToolsForBot,
  /** Resolved per request, because what it signs is who this request turned out to be. */
  signRunForActor?: (actorId: string) => SignRun,
  /** What every built-in Bot is told about the computer. Absent means this deployment has none. */
  computerGuidance?: string,
  /** Which vendors this deployment connects to, held by a Bot or not. Absent means none. */
  loadVendors?: () => Promise<readonly string[]>,
) {
  return async ({ request }: { request: Request }) => {
    const actor = await identifyActor(request);
    return resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor?.(actor.id),
      signRunForActor?.(actor.id),
      computerGuidance,
      loadVendors,
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
  loadToolsForActor?: (actorId: string) => LoadToolsForBot,
  signRunForActor?: (actorId: string) => SignRun,
  basePath = "/api/copilotkit",
  loadVendors?: () => Promise<readonly string[]>,
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
    // Carried on the events the runtime already sends, so OpenBot's traffic is separable from any
    // other deployment's. Adds no events of its own.
    ...(config.accessibility
      ? { telemetryProperties: { accessibility_title: "OpenBot" } }
      : {}),
    // `identifyUser` is the Intelligence projection of the same person `identifyActor` returns:
    // one resolver decides both whose threads these are and whose coworkers exist.
    agents: createRequestAgents(
      identifyActor,
      loadAgents,
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor,
      signRunForActor,
      /*
       * Only when a computer exists. The tools themselves are registered by the surface, so a Bot is
       * offered them without this and the guidance is what tells it how they go together: snapshot
       * before acting, and ask a person to take the wheel at a sign-in rather than reporting the task
       * as impossible. Absent computer, absent guidance: a Bot is not told about hands it has not got.
       */
      config.computer ? COMPUTER_GUIDANCE : undefined,
      loadVendors,
    ) as never,
  });

  return createCopilotHonoHandler({ runtime, basePath });
}
