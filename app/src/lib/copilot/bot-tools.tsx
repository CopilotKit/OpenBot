import { useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import {
  type CreatedBot,
  ProposedBotCard,
} from "@/components/agents/proposed-bot";
import {
  answerListBotSkills,
  answerListBots,
  answerReadBot,
} from "@/lib/agents/answers";
import type { AgentFormValues } from "@/lib/agents/form";
import { agentInputFrom } from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import {
  BOT_CREATOR_SLUG,
  ownershipOf,
  type ProposedBot,
  proposedBotSchema,
} from "@/lib/agents/proposal";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { grantPlugin, invalidatePlugins } from "@/lib/plugins/mutations";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/**
 * Making a coworker from inside a conversation.
 *
 * The deployment ships a skill called `bot-creator` whose instruction is how to interview somebody
 * about the coworker they want. These four tools are what let that interview end in a coworker
 * rather than in a wall of text somebody has to retype into a form: three reads so the Bot can see
 * what already exists and what it may put on the new one, and one write that suspends the run on a
 * card.
 *
 * WHY THE BROWSER AND NOT THE SERVER. A coworker is created as a person, not as a Bot: it goes on
 * their roster under their name, and whether they may make one is a question about them. `POST
 * /api/agents` already answers exactly that, and writes the `bot.created` audit row with the actor
 * on it, so a tool riding the signed-in session inherits every bit of that unchanged. A server-side
 * tool would have to carry an actor into runs that do not always have one — a routine, a Slack
 * thread, a schedule — and the first way that goes wrong is a coworker created under the wrong name,
 * on a roster nobody chose. Nothing is lost by it living here: making a coworker is an interview, so
 * there is nobody to interview where there is no browser.
 *
 * WHY THEY ARE GATED ON THE GRANT. Four more tools on every run is not free — a model picks the
 * right tool reliably out of about ten, which is the whole reason per-run narrowing exists — and a
 * Bot for looking up transactions has no business making coworkers. So the gate is the ordinary one:
 * the Bot has to hold the `bot-creator` skill, granted the same way everything else is.
 */

export function BotTools() {
  // Grants are only fetched once a surface has declared its Bot; the placeholder is not one the
  // server knows, and asking would 404 on every poll.
  const declared = useDeclaredBotId();
  // Empty rather than undefined: the factory's own `enabled: agentId.length > 0` is the guard for
  // "no Bot declared yet", so the placeholder never reaches the server.
  const { data: granted } = useQuery(agentPluginsQueryOptions(declared ?? ""));
  const authoring = (granted?.skills ?? []).some(
    (skill) => skill.slug === BOT_CREATOR_SLUG,
  );

  /*
   * The roster, kept in a query because the card reads it on every render to notice a name that is
   * already taken. What the TOOLS answer with is fetched at the moment they are called — see below.
   */
  const { data: agents } = useQuery({
    ...agentListQueryOptions(),
    enabled: authoring,
  });
  const createAgent = useMutation(createAgentMutationOptions(queryClient));

  const roster = useMemo(() => agents ?? [], [agents]);

  /*
   * Every answer is fetched at the moment it is asked for rather than read off a render. See
   * `lib/agents/answers.ts`, which is where the reason is written down and where a test can reach
   * it.
   */
  useFrontendTool({
    name: "list_bots",
    description:
      "The coworkers that already exist here, one line each, with whose each one is and where it runs. Read this before proposing a coworker: the most expensive mistake this job can make is rebuilding one somebody already maintains.",
    parameters: z.object({}),
    available: authoring,
    handler: async () => answerListBots(queryClient),
  });

  useFrontendTool({
    name: "read_bot",
    description:
      "One existing coworker in full, including the standing instructions it runs on. Use this when somebody asks for one like an existing coworker — never paraphrase a role description you have not read.",
    parameters: z.object({
      name: z.string().describe("The coworker's name, as list_bots spells it."),
    }),
    available: authoring,
    handler: async ({ name }) => answerReadBot(queryClient, String(name)),
  });

  useFrontendTool({
    name: "list_bot_skills",
    description:
      "The skills that could be put on a new coworker, by slug. Putting a skill on a coworker is the only capability the card grants: a skill is an instruction, so one naming a tool the coworker was not granted simply loads nothing.",
    parameters: z.object({}),
    available: authoring,
    handler: async () => answerListBotSkills(queryClient),
  });

  /**
   * Creating, as a card rather than a handler.
   *
   * Stabilised with `useMemo` for the reason the gallery's decisions are: the render component is
   * identity-compared, and a fresh function every render remounts the card, which would reset the
   * pressed-Creating state, the refusal the server has just given it, and the id of a coworker that
   * by then already exists.
   */
  const Card = useMemo(
    () =>
      function ProposedBotRender(props: {
        args: Partial<ProposedBot>;
        respond?: (result: unknown) => Promise<void>;
        result?: string;
      }) {
        const proposed = props.args.name?.trim().toLowerCase();
        const existing = proposed
          ? roster.find(
              (candidate) => candidate.name.toLowerCase() === proposed,
            )
          : undefined;
        return (
          <ProposedBotCard
            args={props.args}
            clashes={
              existing
                ? {
                    ownership: ownershipOf(existing),
                    title: existing.name,
                  }
                : undefined
            }
            create={async (values: AgentFormValues, chosen: string[]) => {
              /*
               * TWO CALLS, AND THE SECOND ONE IS PER SKILL. `POST /api/agents` makes the coworker
               * and `POST /api/plugins/grants` puts a skill on it, which is how the profile screen
               * does both — so ownership, refusal and the audit rows are the existing ones rather
               * than a third path that has to be kept in step with them.
               *
               * The cost is that the pair is not atomic: a grant that fails after the coworker
               * exists leaves it with fewer skills than were agreed. Rather than roll the coworker
               * back — which would delete something the person just watched being made, over a
               * skill they can add in two clicks — each failure is collected and reported, and the
               * card says which ones did not land.
               */
              const agent = await createAgent.mutateAsync(
                agentInputFrom(values),
              );
              const outcome: CreatedBot = {
                agentId: agent.id,
                failed: [],
                granted: [],
                name: agent.name,
              };
              for (const slug of chosen) {
                try {
                  await grantPlugin({
                    agentId: agent.id,
                    kind: "skill",
                    ref: slug,
                  });
                  outcome.granted.push(slug);
                } catch {
                  outcome.failed.push(slug);
                }
              }
              // Once at the end rather than between every pair, matching `grantPlugin`'s own note.
              if (outcome.granted.length > 0) invalidatePlugins(queryClient);
              return outcome;
            }}
            respond={props.respond}
            result={props.result}
          />
        );
      },
    [createAgent, roster],
  );

  useHumanInTheLoop({
    name: "save_bot",
    description:
      "Put a finished coworker in front of the person to create. They see its name, its job, the whole of its standing instructions and the skills it will hold, and nothing is written unless they press the button. Call this once, at the end, after they have agreed to what the coworker will be told to do — not to check your draft.",
    parameters: proposedBotSchema,
    available: authoring,
    render: Card,
  });

  return null;
}
