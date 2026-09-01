import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import {
  BuiltInAgent,
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import type { Observable } from "rxjs";
import { defer, from, switchMap } from "rxjs";
import { z } from "zod";
import {
  COMPUTER_GUIDANCE,
  PROVENANCE_GUIDANCE,
} from "../../shared/bot-prompt";
import type { AgentActor } from "./agents/profile-types";
import type { AgentFetch, StallGuard } from "./channels/stall-guard";
import { COMPUTER_TOOLS } from "./computer/schema";
import type { DeploymentConfig } from "./config";
import type { SelectableSkill, Selection } from "./plugins/selection";
import {
  latestUserText,
  SELECTION_FLOOR,
  selectTools,
} from "./plugins/selection";
import type { GrantedTool } from "./plugins/tools";
import { grantedToolGuidance } from "./plugins/tools";

/**
 * Browser tools that a remote Bot may call back through this deployment.
 *
 * Human handoff and secret-entry tools deliberately stay in the browser: their handlers wait for a
 * person for up to ten minutes, while a remote agent callback is one synchronous HTTP request. The
 * tools here all have a complete server-side implementation in `ComputerGateway`, so the remote Bot
 * gets the same policy decision and audit row as a built-in Bot.
 */
const REMOTE_COMPUTER_TOOLS = new Set<string>([
  ...COMPUTER_TOOLS,
  // The command tool predates COMPUTER_TOOLS but is governed by the same gateway.
  "computer_run_command",
]);

export function remoteComputerToolAliases(tools: RunAgentInput["tools"] = []) {
  return tools
    .filter((tool) => REMOTE_COMPUTER_TOOLS.has(tool.name))
    .map((tool) => ({ ...tool, name: `openbot_${tool.name}` }));
}

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
  /** How a run's tools are narrowed to what it is about. Absent means they are not. */
  selection?: ToolSelection,
  /**
   * The fetch a remote agent is dialled with.
   *
   * Absent uses the runtime's own, which follows redirects wherever they point. A deployment passes
   * one that re-checks each hop, because the address a registration was validated against and the
   * address a run finally reaches are only the same address while nobody redirects.
   */
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoff?: HandoffForRun,
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
          selection,
          agentFetch,
          handoff,
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
  selection?: ToolSelection,
  agentFetch?: AgentFetch,
  handoff?: HandoffForRun,
): Promise<AbstractAgent> {
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }

  const granted = await loadTools(agent.id);

  /*
   * Whether narrowing can do anything here at all.
   *
   * A skill that declares no tools is not a unit of retrieval, and a catalogue already small enough
   * to choose from has nothing to gain. In both cases the Bot is built exactly as it was before any
   * of this existed: no deferral, no per-run model call, nothing to go wrong. That is most
   * deployments on their first day, and they should not pay for a feature they are not using.
   */
  const skills = selection
    ? await selection.loadSkills(agent.id).catch(() => [])
    : [];
  const narrowing =
    selection &&
    skills.some((skill) => skill.tools.length > 0) &&
    granted.length > (selection.floor ?? SELECTION_FLOOR)
      ? selection
      : undefined;

  /** Pass one and pass two, for one run. Shared by both agent kinds; each applies it differently. */
  const offeredFor = async (input: RunAgentInput): Promise<GrantedTool[]> => {
    if (!narrowing) return granted;
    const chosen = await selectTools({
      tools: granted,
      skills,
      text: latestUserText(input.messages),
      choose: narrowing.choose,
      ...(narrowing.floor === undefined ? {} : { floor: narrowing.floor }),
    });
    // Awaited, so the row is on record before the model is handed the tools it names. A discovery
    // written afterwards would sit in the trail after the calls it explains.
    await narrowing.record?.(agent.id, chosen).catch(() => {});
    return chosen.offered;
  };

  if (agent.type === "remote_ag_ui") {
    /*
     * The remote path narrows inside its own middleware rather than by being wrapped.
     *
     * `.use()` middleware is applied by `runAgent`, not by `run`, so an outer agent delegating to
     * `remote.run(input)` skips it: the endpoint would get a run with no standing role, no holdings
     * message, no tools and no signed assertion, and every one of those failures is silent.
     *
     * WHICH IS ALSO WHY A REMOTE BOT IS OFFERED NEITHER `message_bot` NOR `ask_person`. Both are
     * executed here, by the wrapper below, against this deployment's grants and caps. A Bot at an
     * endpoint runs its own loop and is handed descriptions of tools it may call back for, and the
     * callback path executes MCP refs only — so a described `message_bot` would be a tool it could
     * announce and never invoke. Granting one is refused at the door rather than stored dead: see
     * `enablementRefusal` in plugins/routes.ts.
     *
     * Making this work is a feature rather than a fix: the callback would have to carry a run
     * assertion the endpoint cannot forge, and execute a hop on its behalf. Worth doing; not done
     * here, and worth knowing it is missing rather than assuming it is not.
     */
    return remoteAgentWithStandingRole(
      agent,
      stallGuard,
      granted,
      signRun,
      connectedVendors,
      narrowing ? offeredFor : undefined,
      agentFetch,
    );
  }

  /*
   * A built-in Bot takes its tools in its configuration, so narrowing means building it again once
   * the message is known. The guidance it is given is generated from the tools passed here, which is
   * what keeps a narrowed run from being told it holds something it was not offered.
   */
  const withTools = (tools: GrantedTool[]) =>
    new BuiltInAgent(
      builtInAgentConfiguration(
        agent,
        model,
        apiKey,
        tools,
        computerGuidance,
        connectedVendors,
      ),
    );

  const whole = withTools(granted);
  if (!narrowing && !handoff) return whole;

  return new RunBuiltAgent(
    { agentId: agent.id, description: agent.name },
    whole,
    async (input) => {
      const offered = narrowing ? await offeredFor(input) : granted;
      /*
       * The tool for handing work to another Bot is made per run, not per request.
       *
       * It has to know which run is asking: how deep the chain already is, and which conversation an
       * answer belongs in. Both live on the run rather than on the request, and both have to be this
       * deployment's own statement rather than anything the model can edit. A request is earlier
       * than a run and knows neither.
       */
      const passing = (await handoff?.(agent.id, input)) ?? [];
      const tools = passing.length > 0 ? [...offered, ...passing] : offered;
      // Nothing added and nothing narrowed means nothing to rebuild, and reusing the agent already
      // built for this request keeps that path allocation-for-allocation what it was.
      return tools.length === granted.length && passing.length === 0
        ? whole
        : withTools(tools);
    },
  );
}

/**
 * The tools a run gets for reaching past itself: handing work to another Bot, and asking a person.
 *
 * Given the Bot and the run, because the answers depend on both: which Bots this one has been
 * granted, and how deep the chain it is already part of has gone. Empty means this run reaches
 * nobody, which is the right shape for a deployment with the capability switched off.
 *
 * The two arrive together because a model chooses between them. Offering the way to hand work
 * sideways without the way to stop and ask leaves the model one exit from a decision it cannot make,
 * and it takes it: it asks a Bot that cannot settle the question either.
 */
export type HandoffForRun = (
  botId: string,
  input: RunAgentInput,
) => Promise<readonly GrantedTool[]>;

/**
 * How a deployment narrows a Bot's tools to the ones a run is about. Absent means it does not.
 *
 * Three collaborators rather than one, because they fail differently and are configured in
 * different places: the skills come from the plugin store, the choosing is a model call on the
 * deployment's own key, and the record goes to the audit trail. A deployment missing any of them
 * should lose the narrowing and keep the Bot, which is why `record` is optional and the other two
 * are allowed to throw.
 */
export type ToolSelection = {
  /** What this Bot's granted skills declare. Failure is treated as "no skills". */
  loadSkills: (botId: string) => Promise<SelectableSkill[]>;
  /** Pass one. Returns the model's raw answer; throwing means the narrowing is skipped. */
  choose: (prompt: string) => Promise<string | null>;
  /** Writes the discovery row. Never allowed to fail a run. */
  record?: (botId: string, selection: Selection<GrantedTool>) => Promise<void>;
  /** Overrides the default catalogue size below which nothing is narrowed. */
  floor?: number;
};

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
  /**
   * Which of those tools this run is about, decided once the message is known.
   *
   * NARROWED HERE RATHER THAN BY WRAPPING THE AGENT, and the difference is not cosmetic. Middleware
   * registered with `.use()` is applied by `runAgent`, not by `run`: an outer agent that delegated
   * to `remote.run(input)` would skip this whole function's work, and the endpoint would receive a
   * run with no standing role, no holdings message, no tools and no signed assertion. Every one of
   * those is silent — the Bot simply answers worse — so the narrowing goes inside the middleware
   * that is already here.
   *
   * Absent means no narrowing, which is the behaviour every deployment had before this existed.
   */
  narrow?: (input: RunAgentInput) => Promise<GrantedTool[]>,
  /** The fetch this agent is dialled with. See {@link buildAgents}. */
  agentFetch?: AgentFetch,
) {
  const remote = new HttpAgent({
    url: agent.endpoint,
    agentId: agent.id,
    // The customer's own key, if their agent sits behind one. `HttpAgentConfig` is
    // `{ url, headers?, fetch? }`, verified against @ag-ui/client 0.0.57.
    ...(agent.headers ? { headers: agent.headers } : {}),
    // The watch wraps whichever fetch is underneath, so a deployment gets both the stall timeout and
    // the redirect check rather than having to choose.
    ...(stallGuard
      ? {
          fetch: stallGuard.watch(
            { id: agent.id, name: agent.name },
            agentFetch,
          ),
        }
      : agentFetch
        ? { fetch: agentFetch }
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
   *
   * Built from the tools this run was offered rather than from everything granted, so a narrowed
   * run is never told it holds a system it cannot reach on this turn.
   */
  const holdingsMessageFor = (offered: GrantedTool[]) => {
    const holdings = grantedToolGuidance(offered, connectedVendors);
    return holdings
      ? {
          id: `granted-tools:${agent.id}`,
          role: "system" as const,
          content: holdings,
        }
      : null;
  };

  const runWith = (
    tools: GrantedTool[],
    input: RunAgentInput,
    next: AbstractAgent,
  ) => {
    const holdingsMessage = holdingsMessageFor(tools);
    /*
     * The browser already registered the `computer_*` names as frontend handlers. If the remote Bot
     * called one of those names after the server executed it, AG-UI would make the browser execute
     * the same action again. The remote endpoint gets an aliased copy; only the signed callback maps
     * it back to the governed gateway.
     */
    const computerTools = remoteComputerToolAliases(input.tools);
    return next.run({
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
        ...computerTools,
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
        openbotDeploymentTools: [
          ...new Set([
            ...tools.map((tool) => tool.name),
            ...computerTools.map((tool) => tool.name),
          ]),
        ],
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
          ? { openbotRun: signRun(agent.id, input.runId, input.threadId) }
          : /*
             * Absent means this deployment cannot sign, so the agent is given nothing to hand back
             * and its tool calls will be refused. That is the right direction to fail: a Bot that
             * cannot prove whose run it is should not be spending anybody's grants.
             */
            {}),
      },
    } as never);
  };

  /*
   * Deferred, because choosing the tools is a model call and middleware has to answer with a stream
   * straight away. `defer` puts the work on the subscription, which is where the run actually
   * begins, so nothing happens until somebody is listening and a retried run chooses again.
   */
  remote.use((input, next) =>
    defer(() =>
      from(narrow ? narrow(input) : Promise.resolve(tools)).pipe(
        switchMap((offered) => runWith(offered, input, next)),
      ),
    ),
  );

  return remote;
}

/**
 * An agent whose tools are decided when the run starts, because that is the first moment anybody
 * knows what the run is about, and who is asking on whose behalf.
 *
 * WHY A WRAPPER AND NOT A NARROWER `loadTools`. Tools are resolved per request, and a request is
 * earlier than a run: at that point there is a Bot and a person and no message, so there is nothing
 * to select against. `run(input)` is the first place the message exists. Both underlying agents take
 * their tools at construction — a built-in one in its configuration, a remote one in the middleware
 * that sends them — so the only way to hand either a set chosen from the message is to build it
 * after the message arrives. That is all this does: it defers `build` to the first subscription and
 * then gets out of the way.
 *
 * The deferral is per subscription, so a retried run reselects rather than reusing a decision made
 * for a message that is no longer the last one.
 */
class RunBuiltAgent extends AbstractAgent {
  /**
   * The agent this run turned into, once there is one.
   *
   * Held only so `abortRun` can reach it. Without this, pressing stop aborts a wrapper that is not
   * doing anything and leaves the model call underneath it running to completion, spending the
   * deployment's money on an answer nobody will see.
   */
  private inner?: AbstractAgent;
  /** The same Bot with nothing narrowed, kept to answer questions that are not about one run. */
  private whole: AbstractAgent;
  private build: (input: RunAgentInput) => Promise<AbstractAgent>;

  constructor(
    identity: { agentId: string; description: string },
    whole: AbstractAgent,
    build: (input: RunAgentInput) => Promise<AbstractAgent>,
  ) {
    super(identity);
    this.whole = whole;
    this.build = build;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() =>
      from(this.build(input)).pipe(
        switchMap((agent) => {
          this.inner = agent;
          return agent.run(input);
        }),
      ),
    );
  }

  /**
   * What the Bot can do, answered from the un-narrowed agent.
   *
   * Capabilities are asked for outside a run, where there is no message and so nothing to select
   * against. They are also a fact about the Bot rather than about one turn: a deployment that
   * narrowed this run to three tools has not stopped supporting whatever the underlying agent
   * supports.
   */
  getCapabilities() {
    return this.whole.getCapabilities?.() ?? Promise.resolve({});
  }

  /**
   * Carried by hand, because `AbstractAgent.clone` does not know this class exists.
   *
   * It builds a bare object on the prototype and copies a fixed list of base fields onto it, so
   * every field declared here arrives `undefined`. The runtime clones an agent before every run
   * (`agents[agentId].clone()`), which means the omission is not a corner case: without this, the
   * first message anybody sends fails on a `build` that is not a function.
   */
  clone(): RunBuiltAgent {
    const cloned = super.clone() as RunBuiltAgent;
    cloned.whole = this.whole;
    cloned.build = this.build;
    // Deliberately not the inner agent. A clone is a new run, and inheriting the last run's agent
    // would point `abortRun` at something already finished.
    cloned.inner = undefined;
    return cloned;
  }

  abortRun(): void {
    this.inner?.abortRun();
    super.abortRun();
  }
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
  selection?: ToolSelection,
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoff?: HandoffForRun,
  /**
   * Build only this one, when the caller wants only this one.
   *
   * A hop delivery and a routine's turn each want a single Bot, and both were resolving the whole
   * roster to reach it: every registered Bot constructed, and a granted-tools query for each, with
   * all but one thrown away. On a hop that is paid again on every retry. The roster is still LOADED
   * in full, because which Bots exist for this person is what decides whether the one asked for is
   * theirs to see at all; what narrows is what gets built.
   */
  onlyBotId?: string,
): Promise<Record<string, AbstractAgent>> {
  const all = await loadAgents();
  if (all.length === 0) {
    throw new Error(
      "No agents are registered. Add one to the tenant package or the agents table.",
    );
  }
  const registered =
    onlyBotId === undefined
      ? all
      : all.filter((agent) => agent.id === onlyBotId);
  // Not an error: a caller asking for a Bot this person cannot see gets an empty result and decides
  // what that means, exactly as it would have from a roster that did not contain it.
  if (registered.length === 0) return {};

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
    selection,
    agentFetch,
    handoff,
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
export type SignRun = (
  botId: string,
  runId: string,
  /** Which conversation, so a Bot handing work on cannot choose where the answer lands. */
  threadId: string,
) => string;

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
  /**
   * How a run's tools are narrowed, resolved for whoever is asking.
   *
   * Per actor like the tools themselves, because the skills a Bot holds are read through the same
   * grants, and because the discovery row has to name the person the run belongs to.
   */
  selectionForActor?: (actorId: string) => ToolSelection,
  /** The fetch remote agents are dialled with. See {@link buildAgents}. */
  agentFetch?: AgentFetch,
  /**
   * How a run gets its tool for handing work to another Bot, resolved for whoever is asking.
   *
   * Per actor for the same reason the tools are: which Bots may be reached is decided against the
   * roster that person can see, so a Bot must never be able to address one they cannot.
   */
  handoffForActor?: (actorId: string) => HandoffForRun,
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
      selectionForActor?.(actor.id),
      agentFetch,
      handoffForActor?.(actor.id),
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
/**
 * Whether this failure means "the platform has never heard of that thread".
 *
 * A thread id is minted before the thread exists — the platform creates it on the first run — so
 * reading history on a brand-new conversation is the normal opening move, and the platform answers
 * `THREAD_NOT_FOUND` with a 404. The runtime's own handler catches everything and returns a bare 500,
 * so every new chat produced one, with a stack trace behind it.
 *
 * Matched on the shape rather than with `instanceof`. The class is `PlatformRequestError` and it
 * carries `.status` for exactly this — its own documentation gives `error.status === 404` as the
 * example — but it is not re-exported from `@copilotkit/runtime/v2`, and the package's `exports` map
 * offers no subpath that reaches it, so there is no type to test against. The name is set by the
 * constructor and the status is a number on the instance; both are checked, so an unrelated error
 * carrying a `status` of 404 does not qualify.
 *
 * 404 ONLY, and nothing wider. A 500 from the platform means an outage or a bad key, and answering
 * that with an empty history would tell the browser the conversation is gone and invite somebody to
 * start it over. That is the failure this must not introduce while removing the noisy one.
 */
export function isMissingThread(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 404
  );
}

/**
 * Read a thread's history, treating a thread the platform does not know about as having none.
 *
 * Takes the read as a function rather than being folded into the class below, so the decision can be
 * exercised against a function that really throws. The previous attempt at this fix
 * (#71) was tested by re-implementing its middleware inside the test file, which passes with the real
 * code deleted; this is the actual code path in both places.
 */
export async function historyOrEmpty<T>(
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingThread(error)) return whenMissing;
    throw error;
  }
}

/**
 * The platform client, with one answer corrected.
 *
 * A subclass rather than a wrapper. The runtime is handed this object and calls many methods on it,
 * and the base class keeps its state in `#private` fields — which a `Proxy` cannot forward, because a
 * method invoked with the proxy as `this` cannot reach them. Extending keeps every other method
 * exactly as it was, on the instance that owns those fields.
 *
 * `getThreadMessages` is the only override. `handleGetThreadMessages` in the runtime calls it and
 * returns `Response.json` of whatever comes back, so an empty history here is the `{ messages: [] }`
 * the browser expects and a 200 instead of a 500.
 */
class IntelligenceKnowingANewThread extends CopilotKitIntelligence {
  override getThreadMessages(
    params: Parameters<CopilotKitIntelligence["getThreadMessages"]>[0],
  ) {
    return historyOrEmpty(() => super.getThreadMessages(params), {
      messages: [],
    });
  }
}

/**
 * How long a conversation's lock is held before it lapses on its own.
 *
 * Matches the platform's own default rather than picking a number: this is renewed while a Bot works,
 * so what it really sets is how long a conversation stays stuck after a process dies mid-run.
 */
const THREAD_LOCK_TTL_SECONDS = 120;

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
  selectionForActor?: (actorId: string) => ToolSelection,
  /** The fetch remote agents are dialled with. See {@link buildAgents}. */
  agentFetch?: AgentFetch,
  /** How a run gets its tool for handing work on. Absent means no Bot is offered one. */
  handoffForActor?: (actorId: string) => HandoffForRun,
  /**
   * Told when a run starts and ends on a thread, so a channel can show it is working.
   *
   * The universal seam: every run the runtime processes — a person's own turn, a headless hop —
   * takes and gives back the thread lock, and it does so on the server, so a person who sends a
   * message and navigates away still lights the channel they left. A side effect only: it is never
   * awaited in the lock path and a failure in it never touches whether the lock was taken.
   */
  onRunBusy?: (input: { threadId: string; busy: boolean }) => void,
) {
  const { intelligence } = config.runtime;

  /**
   * The same Bot a person's run would get, built without a request.
   *
   * Handed out from here rather than assembled again elsewhere, because "built exactly the way a
   * person's run builds it" is a property worth guaranteeing structurally. A hop delivering to a Bot
   * assembled by parallel wiring would drift the first time one of these arguments changed, and the
   * drift would be invisible: the Bot would run, and quietly hold different tools or a different
   * role from the one the person talks to.
   */
  const agentFor = async (input: {
    /**
     * The person, WITH THEIR ROLE, rather than an id this rebuilds a role for.
     *
     * An administrator sees Bots a user does not. Assumed to be a user here while the desk resolved
     * the real role, the two disagreed in the worst direction: the desk accepted an administrator's
     * hop to a Bot only they can see, the model was told it had been handed over, and then every
     * delivery attempt failed to build that Bot and the person was told it never answered. A
     * refusal that failed closed became a lie that failed slowly.
     */
    actor: AgentActor;
    botId: string;
  }): Promise<AbstractAgent | null> => {
    const { actor } = input;
    const agents = await resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor?.(actor.id),
      signRunForActor?.(actor.id),
      config.computer ? COMPUTER_GUIDANCE : undefined,
      loadVendors,
      selectionForActor?.(actor.id),
      agentFetch,
      handoffForActor?.(actor.id),
      // Only the Bot this hop is for. The roster is still read in full, so a Bot this person cannot
      // see is still absent; what this skips is constructing the other Bots and asking the database
      // what each of them was granted, on every delivery and again on every retry.
      input.botId,
    );
    return agents[input.botId] ?? null;
  };

  /*
   * One client, used by the runtime and by anything reading a thread beside it, so a hop reads the
   * history a person's run would read rather than a second view of it that could disagree.
   */
  const intelligenceClient = new IntelligenceKnowingANewThread({
    apiUrl: intelligence.apiUrl,
    wsUrl: intelligence.gatewayWsUrl,
    apiKey: intelligence.apiKey,
  });

  const runtime = new CopilotRuntime({
    // `mode` is inferred from the presence of `intelligence`; passing it is a type error.
    //
    // identifyUser is NOT optional in practice. Threads and memory are scoped to the user it
    // returns, so omitting it puts every person in the deployment in the same thread space and one
    // person's conversations become another's.
    identifyUser,
    // The subclass, not the base: a thread nobody has run yet reads as empty rather than as a 500.
    // See IntelligenceKnowingANewThread.
    intelligence: intelligenceClient,
    licenseToken: intelligence.licenseToken,
    // Carried on the events the runtime already sends, so OpenBot's traffic is separable from any
    // other deployment's. Adds no events of its own.
    ...(config.accessibility
      ? { telemetryProperties: { accessibility_title: "OpenBot" } }
      : {}),
    /*
     * What lets a Bot answer with an interface it wrote itself.
     *
     * This one flag is the whole difference between a Bot that draws and a Bot that describes
     * markup it cannot show. The middleware it turns on does not give the model the tool — the
     * browser does that — it reads the arguments of the `generateSandboxedUi` call as they stream
     * and re-emits them as `open-generative-ui` activity events. Those events are the only thing
     * that paints: the tool's own renderer shows the waiting message and then returns nothing. So a
     * deployment with the browser half and not this one has Bots generating whole interfaces that
     * never appear, which is the shape this capability arrived in.
     *
     * `true` rather than a list of Bots. The list narrows only the event transform, and the tool
     * stays offered to every Bot regardless, so naming some Bots here would leave the others able to
     * call it and draw nothing. Whether the capability exists at all is the switch this deployment
     * has; see DeploymentConfig.generativeUi.
     */
    ...(config.generativeUi ? { openGenerativeUI: true } : {}),
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
      selectionForActor,
      agentFetch,
      handoffForActor,
    ) as never,
  });

  return {
    handler: createCopilotHonoHandler({ runtime, basePath }),
    /**
     * How to reach the platform's runner, exactly as the runtime reaches it.
     *
     * TAKEN FROM THE CLIENT, NOT FROM CONFIGURATION, and this is the whole of a bug that only a real
     * gateway could show. Built from `gatewayWsUrl` and the deployment's API key, every join was
     * refused with `active_lock_mismatch`: a thread's active run is a lock the platform issues, and
     * the token that holds it is not the API key. The runtime asks the client for both, so anything
     * else driving a run has to ask the same client the same way.
     */
    runnerConnection: () => ({
      url: intelligenceClient.ɵgetRunnerWsUrl(),
      authToken: intelligenceClient.ɵgetRunnerAuthToken(),
    }),
    /**
     * The conversation's run lock, as the platform issues it.
     *
     * ONE RUN AT A TIME PER CONVERSATION. Taken before anything is streamed, because the gateway
     * checks every event against the run the lock names: a run that skips this is claiming to be one
     * nobody was told about, and every event is refused. That refusal reads like a platform
     * limitation and is a missing step.
     *
     * A conversation somebody else is already running in refuses rather than queues, which is right:
     * the caller waits and tries again rather than two Bots writing over each other.
     */
    threadLock: {
      acquire: async (input: {
        threadId: string;
        runId: string;
        userId: string;
        agentId: string;
      }) => {
        try {
          const held = await intelligenceClient.ɵacquireThreadLock(input);
          // A run started on this thread. Side effect only, never awaited: a channel showing it is
          // working is worth nothing next to the lock the run depends on.
          try {
            onRunBusy?.({ threadId: input.threadId, busy: true });
          } catch {}
          /*
           * The run id only. The lock also hands back a join token, which is what a browser presents
           * to watch the conversation; the runner's socket has its own credential and passing this
           * one in place of it means a socket that is refused and a run that never starts. See the
           * note on `runner.run` in handoff-delivery.ts.
           */
          return { runId: held.runId };
        } catch (error) {
          /*
           * ONLY A CONFLICT MEANS "NOT NOW". Everything else is raised.
           *
           * A conversation somebody is already running in answers 409, and that is ordinary: the hop
           * waits and is tried again. Anything else is not — a platform that cannot be reached, a
           * token that stopped working, or one of the underscored APIs below being renamed by a
           * routine version bump. Returned as `null` those all read as contention: every hop retries
           * to exhaustion, every person is told their question was never answered, and the only
           * evidence is a warning line that looks like a busy conversation.
           *
           * Raised, the runner writes the real reason onto `agent.handoff_failed`, and the sentence
           * the person eventually gets names it.
           */
          const status =
            error instanceof Error && "status" in error
              ? (error as { status?: unknown }).status
              : undefined;
          if (status === 409) return null;
          throw error;
        }
      },
      renew: async (input: { threadId: string; runId: string }) => {
        await intelligenceClient.ɵrenewThreadLock({
          ...input,
          ttlSeconds: THREAD_LOCK_TTL_SECONDS,
        });
      },
      release: async (input: { threadId: string; runId: string }) => {
        // The run on this thread is over. Cleared here rather than trusting a browser: the run may
        // have outlived the tab that started it, and this is where the platform is told it ended.
        try {
          onRunBusy?.({ threadId: input.threadId, busy: false });
        } catch {}
        await intelligenceClient.ɵcleanupThreadLock(input);
      },
    },
    agentFor,
    /**
     * A thread's messages, as the platform holds them.
     *
     * The same client the runtime uses, so a hop reads the history a person's run would read rather
     * than a second view of it that could disagree.
     */
    history: async (input: { threadId: string; actorId: string }) => {
      /*
       * The platform's own message type rather than AG-UI's, inferred rather than named: the two are
       * compatible where it matters and naming the wrong one here would mean converting a history
       * that does not need converting.
       */
      type Read = Awaited<
        ReturnType<CopilotKitIntelligence["getThreadMessages"]>
      >;
      const read = await historyOrEmpty<Read>(
        () =>
          intelligenceClient.getThreadMessages({
            threadId: input.threadId,
            userId: input.actorId,
          }),
        { messages: [] } as Read,
      );
      return read.messages;
    },
  };
}
