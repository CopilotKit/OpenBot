import type { RunAgentInput, Tool } from "@ag-ui/core";
import {
  type ReactFrontendTool,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect } from "react";
import { defer, from, mergeMap } from "rxjs";
import { agentQueryOptions } from "@/lib/agents/queries";
import { agentComponentsQueryOptions } from "@/lib/components/queries";
import { botOfAgent } from "@/lib/copilot/active-bot";
import {
  type CapabilityKey,
  myCapabilitiesQueryOptions,
} from "@/lib/enterprise/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";

/**
 * What a conversation's run is offered: the tools of ITS Bot, never those of the Bot on screen.
 *
 * THE OFFER USED TO FOLLOW THE SCREEN. Every frontend tool is registered once for the whole app, and
 * whether a run was offered one was its `available` flag, worked out from whichever Bot the screen
 * was showing: its component grants, its computer switches, its skills. A turn the person walked away
 * from keeps running (see `botOfCall`), and every step after the first is a new run, offered what the
 * screen said by then. Off any conversation the screen names no Bot, so a Bot that had just drawn a
 * record was not offered the record card for its next step and drew a lookalike with the generic
 * `render_ui` under the real one. In another Bot's conversation it was offered that Bot's components,
 * that Bot's computer and that Bot's authoring tools.
 *
 * SO THE SCREEN NO LONGER DECIDES. The SDK leaves a tool out of a run's list before anything that
 * knows the run's Bot can see it when `available` is false (`buildFrontendTools`), so every tool
 * whose offer depends on the Bot is now registered as available, with a rule here saying who is
 * offered it. Each agent narrows its own run's list with those rules and the facts of its own Bot,
 * in the browser, before the run leaves (`offerItsOwnTools`, given to every agent by `BotOffers`).
 * The agent outlives the screen that made it, so the narrowing goes on for the steps of a turn the
 * person has left.
 *
 * This decides what the model is told it can do. It is not the boundary: the server still checks the
 * component grant, the computer route and the person's access to the Bot on every call.
 */

/** Everything an offer rule may ask about the Bot a run belongs to. */
export type BotFacts = {
  /** The components this Bot may answer with, by name, with their published descriptions. */
  components: ReadonlyMap<string, string> | undefined;
  /** Who the Bot belongs to, as far as driving its computer goes. Undefined: could not be read. */
  profile: { visibility: string; canManage: boolean } | undefined;
  /** What this deployment lets the person do at all. Undefined: could not be read. */
  capabilities: Partial<Record<CapabilityKey, boolean>> | undefined;
  /** The skills this Bot holds, by slug. */
  skills: ReadonlySet<string>;
};

/** Offered or not, and the words the model is given for it when they belong to the Bot. */
export type Offer = boolean | { description: string };

/** Whether a Bot is offered the tool of this name. */
export type OfferRule = (bot: BotFacts, name: string) => Offer;

/** Offered only to a Bot holding the component of the tool's name, in that component's own words. */
export const heldComponent: OfferRule = (bot, name) => {
  const description = bot.components?.get(name);
  return description === undefined ? false : { description };
};

/**
 * The rules of every tool registered now, by name. A tool without one is offered to every run: its
 * offer does not depend on the Bot.
 */
const rules = new Map<string, OfferRule>();

/**
 * Declare who is offered these tools, for as long as the component registering them is mounted.
 *
 * `offered` must keep its identity between renders (a module constant, or memoised), as a tool's
 * registration does.
 */
export function useOfferedTo(
  offered: Readonly<Record<string, OfferRule>>,
): void {
  useLayoutEffect(() => {
    const entries = Object.entries(offered);
    for (const [name, rule] of entries) rules.set(name, rule);
    return () => {
      for (const [name, rule] of entries)
        if (rules.get(name) === rule) rules.delete(name);
    };
  }, [offered]);
}

/** A run's tool list, narrowed to what this Bot is offered. Pure, for its tests. */
export function offerFor(
  tools: readonly Tool[],
  bot: BotFacts,
  ruleFor: (name: string) => OfferRule | undefined = (name) => rules.get(name),
): Tool[] {
  return tools.flatMap((tool) => {
    const rule = ruleFor(tool.name);
    if (!rule) return [tool];
    const offer = rule(bot, tool.name);
    if (offer === false) return [];
    return offer === true
      ? [tool]
      : [{ ...tool, description: offer.description }];
  });
}

/** How long a fact read for one step is reused by the next, the same as the screen's own poll. */
const FRESH_MS = 5_000;

/**
 * The facts of one Bot, read through the same queries the screen reads them with.
 *
 * Never throws. A fact that cannot be read is undefined, and each rule says what undefined means:
 * no components and no skills, and the computer left to the server, as the screen always did while
 * they loaded.
 */
export async function factsFor(
  queries: QueryClient,
  botId: string,
): Promise<BotFacts> {
  const read = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => value,
      () => undefined,
    );
  const [components, profile, mine, plugins] = await Promise.all([
    read(
      queries.fetchQuery({
        ...agentComponentsQueryOptions(botId),
        staleTime: FRESH_MS,
        retry: false,
      }),
    ),
    read(
      queries.fetchQuery({
        ...agentQueryOptions(botId),
        staleTime: FRESH_MS,
        retry: false,
      }),
    ),
    read(
      queries.fetchQuery({
        ...myCapabilitiesQueryOptions(),
        staleTime: FRESH_MS,
        retry: false,
      }),
    ),
    read(
      queries.fetchQuery({
        ...agentPluginsQueryOptions(botId),
        staleTime: FRESH_MS,
        retry: false,
      }),
    ),
  ]);
  return {
    components: components
      ? new Map(
          components.map((component) => [
            component.name,
            component.description,
          ]),
        )
      : undefined,
    profile,
    capabilities: mine?.capabilities,
    skills: new Set((plugins?.skills ?? []).map((skill) => skill.slug)),
  };
}

type Agent = NonNullable<
  Parameters<NonNullable<ReactFrontendTool["handler"]>>[1]["agent"]
>;

/** No Bot to ask about: nothing that depends on one is offered, and the computer is the server's. */
const NO_BOT: BotFacts = {
  components: undefined,
  profile: undefined,
  capabilities: undefined,
  skills: new Set(),
};

/** The Bot each agent's runs belong to, for the one middleware each agent is given. */
const botOf = new WeakMap<Agent, string | undefined>();

/**
 * Narrow every run of this agent to its own Bot's offer.
 *
 * On the agent, not on the screen, because the agent is what outlives the screen: a channel's agent
 * carries on with a turn after the channel has closed. Installed once per agent; a second call only
 * updates the Bot. Nothing takes it off again, and nothing needs to: it goes when the agent does.
 * An agent that names no Bot is offered nothing that depends on one.
 */
export function offerItsOwnTools(
  agent: Agent,
  botId: string | undefined,
  queries: QueryClient,
): void {
  const installed = botOf.has(agent);
  botOf.set(agent, botId);
  if (installed) return;
  agent.use((input: RunAgentInput, next: Agent) =>
    defer(() => {
      const bot = botOf.get(agent);
      return from(bot ? factsFor(queries, bot) : Promise.resolve(NO_BOT));
    }).pipe(
      mergeMap((bot) =>
        next.run({ ...input, tools: offerFor(input.tools, bot) }),
      ),
    ),
  );
}

/**
 * Give every agent its Bot's offer before its first run, on every surface.
 *
 * The SDK announces a turn (`onAgentRunStarted`) and waits for its subscribers before the agent runs,
 * so this sees every agent a turn runs on: a channel's, a Bot's own page's, and any per-thread copy
 * the SDK makes, which never appears among its registered agents. The steps that follow in the same
 * turn run on the same agent and keep what it was given. Mounted once, beside the tools.
 */
export function BotOffers(): null {
  const { copilotkit } = useCopilotKit();
  const queries = useQueryClient();
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onAgentRunStarted: ({ agent }) => {
        offerItsOwnTools(agent, botOfAgent(agent), queries);
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit, queries]);
  return null;
}
