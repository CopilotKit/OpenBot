import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { getBotDelegation } from "@/lib/api/generated/agents/agents";
import type {
  BotDelegation,
  ListBotAgentsScope,
} from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";

/** How a Bot works, and the agents it may use, the first being its default. */
export type Delegation = BotDelegation;

/**
 * Whether Bots may hand work to agents, which starts task threads.
 * Off for now: OpenBot runs every Bot as one that does the work itself, whatever it is set to. So the
 * app reads every Bot that way too (`workingMode`), and the model picker says what a Bot that does
 * the work itself says. Task cards and threads already made still read as before.
 */
export const TASK_THREADS_OFFERED: boolean = false;

/**
 * How a Bot works, as OpenBot runs it: what it is set to while task threads are offered, otherwise
 * doing the work itself. Every screen reads a Bot's mode through this.
 */
export function workingMode(
  delegation: Pick<Delegation, "mode">,
  offered: boolean = TASK_THREADS_OFFERED,
): Delegation["mode"] {
  return offered ? delegation.mode : "self";
}

export const botAgentKeys = {
  all: ["bot-agents"] as const,
  list: (scope: ListBotAgentsScope = "caller") =>
    ["bot-agents", "list", { scope }] as const,
  detail: (botAgentId: string) => ["bot-agents", "detail", botAgentId] as const,
  delegation: (botId: string) => ["bot-agents", "delegation", botId] as const,
};

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
 * Only a Bot on OpenBot's own model takes a pick, and not one that hands work out (while that is
 * offered at all, `TASK_THREADS_OFFERED`). Hidden while the answer is on its way, so such a Bot never
 * shows the picker for a moment; shown if the answer could not be read.
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
  return delegation.isSuccess && workingMode(delegation.data) !== "orchestrate";
}

/**
 * Whether a conversation with this Bot takes no model pick: the rule of `useBotTakesModelChoice`,
 * asked once. The home composer's pick is made before OpenBot has picked the Bot, so it is asked when
 * the Bot is known, just before its conversation is made.
 */
export async function takesNoModelChoice(
  queryClient: QueryClient,
  bot: { id: string; runsOnOpenBotModel: boolean },
): Promise<boolean> {
  if (!bot.runsOnOpenBotModel) return true;
  try {
    const delegation = await queryClient.fetchQuery(
      botDelegationQueryOptions(bot.id),
    );
    return workingMode(delegation) === "orchestrate";
  } catch {
    // As the hook reads it: a Bot whose answer could not be read takes the pick.
    return false;
  }
}
