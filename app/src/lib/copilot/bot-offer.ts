import type { RunAgentInput, Tool } from "@ag-ui/core";
import { type AbstractAgent, useCopilotKit } from "@copilotkit/react-core/v2";
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
 * in the browser, before the run leaves (`offerItsOwnTools`). It is given to an agent where the agent
 * is made or found: by the conversation that makes it, and by `BotOffers` for every agent the SDK
 * holds or runs. The agent outlives the screen that made it, so the narrowing goes on for the steps
 * of a turn the person has left.
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
 * The rule of every tool registered now, by name, kept per registrant. A tool without one is offered
 * to every run: its offer does not depend on the Bot.
 *
 * PER REGISTRANT, NOT PER NAME. The gallery and the browser-authored components both declare the
 * same rule for a component's name, and a name could be declared by both. Kept as one entry per
 * name, the first of them to leave took the rule with it, and the component it named was then
 * offered to every Bot. Each registration is its own entry now, and only its own leaves with it.
 */
const registered = new Map<string, { rule: OfferRule }[]>();

const ruleOf = (name: string): OfferRule | undefined =>
  registered.get(name)?.at(-1)?.rule;

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
    const mine = Object.entries(offered).map(
      ([name, rule]) => [name, { rule }] as const,
    );
    for (const [name, entry] of mine)
      registered.set(name, [...(registered.get(name) ?? []), entry]);
    return () => {
      for (const [name, entry] of mine) {
        const left = (registered.get(name) ?? []).filter(
          (other) => other !== entry,
        );
        if (left.length > 0) registered.set(name, left);
        else registered.delete(name);
      }
    };
  }, [offered]);
}

/** A run's tool list, narrowed to what this Bot is offered. Pure, for its tests. */
export function offerFor(
  tools: readonly Tool[],
  bot: BotFacts,
  ruleFor: (name: string) => OfferRule | undefined = ruleOf,
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

/** How long a fact is fresh enough not to be fetched again behind a step, as the screen's own poll. */
const FRESH_MS = 5_000;

/**
 * One fact: what is already known, at once, with a fresher copy fetched quietly for the next step.
 * Only a fact never read before is waited for.
 *
 * WITH THE SCREEN'S OWN RETRIES. These are the very queries the screen observes, so a read here that
 * gave up on its first failure put the shared query into an error state: one transient failure, and
 * the cards on screen said the grant could not be checked.
 */
async function fact<T>(
  known: T | undefined,
  refresh: () => Promise<void>,
  fetch: () => Promise<T>,
): Promise<T | undefined> {
  if (known !== undefined) {
    void refresh();
    return known;
  }
  return fetch().catch(() => undefined);
}

/**
 * The facts of one Bot, read through the same queries the screen reads them with.
 *
 * Never throws. A fact that cannot be read is undefined, and each rule says what undefined means:
 * no components, no skills and no computer.
 */
export async function factsFor(
  queries: QueryClient,
  botId: string,
): Promise<BotFacts> {
  const components = agentComponentsQueryOptions(botId);
  const profile = agentQueryOptions(botId);
  const mine = myCapabilitiesQueryOptions();
  const plugins = agentPluginsQueryOptions(botId);
  const [held, owner, allowed, granted] = await Promise.all([
    fact(
      queries.getQueryData(components.queryKey),
      () => queries.prefetchQuery({ ...components, staleTime: FRESH_MS }),
      () => queries.fetchQuery(components),
    ),
    fact(
      queries.getQueryData(profile.queryKey),
      () => queries.prefetchQuery({ ...profile, staleTime: FRESH_MS }),
      () => queries.fetchQuery(profile),
    ),
    fact(
      queries.getQueryData(mine.queryKey),
      () => queries.prefetchQuery({ ...mine, staleTime: FRESH_MS }),
      () => queries.fetchQuery(mine),
    ),
    fact(
      queries.getQueryData(plugins.queryKey),
      () => queries.prefetchQuery({ ...plugins, staleTime: FRESH_MS }),
      () => queries.fetchQuery(plugins),
    ),
  ]);
  return {
    components: held
      ? new Map(
          held.map((component) => [component.name, component.description]),
        )
      : undefined,
    profile: owner,
    capabilities: allowed?.capabilities,
    skills: new Set((granted?.skills ?? []).map((skill) => skill.slug)),
  };
}

/** No Bot to ask about: nothing that depends on one is offered, the computer included. */
const NO_BOT: BotFacts = {
  components: undefined,
  profile: undefined,
  capabilities: undefined,
  skills: new Set(),
};

/** The agents already given the offer. */
const given = new WeakSet<AbstractAgent>();

/**
 * Lists a narrowing has already produced. A copy of an agent (`AbstractAgent.clone()`) carries the
 * middlewares of the agent it was copied from, so a copy given the offer as well holds two; the
 * second sees a list the first already narrowed and passes it on, rather than reading the facts and
 * narrowing again. Both name the same Bot: a copy keeps the ids its Bot is read from.
 */
const narrowed = new WeakSet<readonly Tool[]>();

/**
 * Narrow every run of this agent to its own Bot's offer.
 *
 * On the agent, not on the screen, because the agent is what outlives the screen: a channel's agent
 * carries on with a turn after the channel has closed. Given once per agent, for the Bot it was given
 * for; nothing takes it off again, and nothing needs to: it goes when the agent does. An agent that
 * names no Bot is offered nothing that depends on one.
 */
export function offerItsOwnTools(
  agent: AbstractAgent,
  botId: string | undefined,
  queries: QueryClient,
): void {
  if (given.has(agent)) return;
  given.add(agent);
  agent.use((input: RunAgentInput, next: AbstractAgent) => {
    if (narrowed.has(input.tools)) return next.run(input);
    return defer(() =>
      from(botId ? factsFor(queries, botId) : Promise.resolve(NO_BOT)),
    ).pipe(
      mergeMap((bot) => {
        const tools = offerFor(input.tools, bot);
        narrowed.add(tools);
        return next.run({ ...input, tools });
      }),
    );
  });
}

/**
 * Give every agent the SDK holds or runs its Bot's offer.
 *
 * WHERE THE AGENT IS FOUND, NOT ONLY WHEN IT RUNS. Every agent the SDK holds (a Bot's own page's, a
 * channel's once registered) is given it as it arrives, and every agent a turn runs on is given it as
 * the turn is announced, which also reaches a per-thread copy the SDK never registers. A channel gives
 * its own agent the offer as it makes it (`ChannelChat`), before either. Mounted once, beside the
 * tools.
 */
export function BotOffers(): null {
  const { copilotkit } = useCopilotKit();
  const queries = useQueryClient();
  useEffect(() => {
    const give = (agent: AbstractAgent) =>
      offerItsOwnTools(agent, botOfAgent(agent), queries);
    for (const agent of Object.values(copilotkit.agents)) give(agent);
    const subscription = copilotkit.subscribe({
      onAgentsChanged: ({ agents }) => {
        for (const agent of Object.values(agents)) give(agent);
      },
      onAgentRunStarted: ({ agent }) => give(agent),
    });
    return () => subscription.unsubscribe();
  }, [copilotkit, queries]);
  return null;
}
