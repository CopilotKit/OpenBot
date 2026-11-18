import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import {
  getBotAgent,
  getBotDelegation,
  listBotAgents,
} from "@/lib/api/generated/agents/agents";
import type {
  BotAgent,
  BotDelegation,
  ListBotAgentsScope,
} from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";

/**
 * An agent a Bot may hand work to, as the browser sees it: the `BotAgent` of api/openapi.yaml.
 *
 * `canManage`, `mine` and `builtIn` are the server's verdicts for this person; screens render them
 * and never work them out again. No secret is ever part of one: `hasAuth` and `hasCallbackToken`
 * say whether one is set.
 */
export type AgentRecord = BotAgent;

/** How a Bot works, and the agents it may use, the first being its default. */
export type Delegation = BotDelegation;

export const botAgentKeys = {
  all: ["bot-agents"] as const,
  list: (scope: ListBotAgentsScope = "caller") =>
    ["bot-agents", "list", { scope }] as const,
  detail: (botAgentId: string) => ["bot-agents", "detail", botAgentId] as const,
  delegation: (botId: string) => ["bot-agents", "delegation", botId] as const,
};

/**
 * Every agent in the list, page by page. A server that hands back the cursor it was given would
 * never end the list, so a repeated cursor ends it too (as `everyBot` does).
 */
async function everyAgent(scope: ListBotAgentsScope): Promise<AgentRecord[]> {
  const agents: AgentRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listBotAgents(
      organizationId(),
      {
        ...(scope === "caller" ? {} : { scope }),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
      { fallback: "Couldn't load your agents." },
    );
    agents.push(...page.agents);
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return agents;
}

export function botAgentListQueryOptions(scope: ListBotAgentsScope = "caller") {
  return queryOptions({
    queryKey: botAgentKeys.list(scope),
    queryFn: (): Promise<AgentRecord[]> => everyAgent(scope),
  });
}

export function botAgentQueryOptions(botAgentId: string) {
  return queryOptions({
    queryKey: botAgentKeys.detail(botAgentId),
    queryFn: async (): Promise<AgentRecord> =>
      (
        await getBotAgent(organizationId(), botAgentId, {
          fallback: "Couldn't load this agent.",
        })
      ).agent,
  });
}

export function botDelegationQueryOptions(botId: string) {
  return queryOptions({
    queryKey: botAgentKeys.delegation(botId),
    queryFn: ({ signal }): Promise<Delegation> =>
      getBotDelegation(organizationId(), botId, {
        signal,
        fallback: "Couldn't load how this Bot works.",
      }),
  });
}

/**
 * Whether a person picks the model in a conversation with this Bot.
 *
 * Only a Bot on OpenBot's own model takes a pick, and not one that hands work to agents: that Bot's
 * model is set on its Agents page, and each agent keeps its own. Hidden while the answer is on its
 * way, so an orchestrating Bot never shows the picker for a moment; shown if the answer could not
 * be read, which is how every Bot behaved before agents were a list.
 */
export function useBotTakesModelChoice(
  bot: { id: string; runsOnOpenBotModel: boolean } | undefined,
): boolean {
  const onOpenBotModel = bot?.runsOnOpenBotModel === true;
  const delegation = useQuery({
    ...botDelegationQueryOptions(bot?.id ?? ""),
    enabled: onOpenBotModel,
  });
  if (!onOpenBotModel) return false;
  if (delegation.isError) return true;
  return delegation.isSuccess && delegation.data.mode !== "orchestrate";
}

/**
 * Why a conversation with this Bot takes no model pick, or null when it takes one. The rule of
 * `useBotTakesModelChoice`, asked once: the home composer's pick is made before OpenBot has picked
 * the Bot, so it is asked when the Bot is known, just before its conversation is made.
 */
export async function whyNoModelChoice(
  queryClient: QueryClient,
  bot: { id: string; runsOnOpenBotModel: boolean },
): Promise<"own-agent" | "hands-to-agents" | null> {
  if (!bot.runsOnOpenBotModel) return "own-agent";
  try {
    const delegation = await queryClient.fetchQuery(
      botDelegationQueryOptions(bot.id),
    );
    return delegation.mode === "orchestrate" ? "hands-to-agents" : null;
  } catch {
    // As the hook reads it: a Bot whose answer could not be read takes the pick.
    return null;
  }
}

/** The host of an agent's address, for a row that says where it runs. Null when it can't be read. */
export function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host || null;
  } catch {
    return null;
  }
}

/** Where an agent runs, in a few words: "Runs in OpenBot", "LangChain at agents.example.com". */
export function whereItRuns(agent: {
  kind: AgentRecord["kind"];
  endpoint: string | null;
  framework?: string;
}): string {
  if (agent.kind === "openbot") return "Runs in OpenBot";
  const host = hostOf(agent.endpoint);
  if (agent.framework && host) return `${agent.framework} at ${host}`;
  if (host) return `At ${host}`;
  return agent.framework ?? "At its own address";
}

/** A Bot's Agents row, in a line: "Does the work itself on OpenBot", "Hands work to 2 agents". */
export function delegationSummary(delegation: Delegation): string {
  if (delegation.mode === "orchestrate") {
    const count = delegation.agents.length;
    return `Hands work to ${count} ${count === 1 ? "agent" : "agents"}`;
  }
  const own = delegation.agents[0];
  return own ? `Does the work itself on ${own.name}` : "Does the work itself";
}
