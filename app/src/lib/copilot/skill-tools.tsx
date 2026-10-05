import { useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { ProposedSkillCard } from "@/components/skills/proposed-skill";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import type { SkillFormValues } from "@/lib/skills/form";
import {
  describeSkill,
  describeSkills,
  describeToolRefs,
  ownershipOf,
  type ProposedSkill,
  proposedSkillSchema,
  SKILL_CREATOR_SLUG,
} from "@/lib/skills/proposal";
import { queryClient } from "@/query-client";

/**
 * Writing a skill from inside a conversation.
 *
 * The deployment ships a skill called `skill-creator` whose instruction is how to interview somebody
 * about the skill they want. These four tools are what let that interview end in a saved skill rather
 * than in a wall of text somebody has to retype into a form: three reads so the Bot can see what
 * already exists and which tools it may name, and one write that suspends the run on a card.
 *
 * WHY THE BROWSER AND NOT THE SERVER. A skill is written as a person, not as a Bot: the slug goes
 * under their name, and whether they may take it is a question about them. `POST /api/plugins/skills`
 * already answers exactly that — their own skills, an administrator's for the deployment, a refusal
 * naming the slug otherwise — and a tool that rides the signed-in session inherits every bit of it
 * unchanged, including the audit row. A server-side tool would have to carry an actor into a run that
 * does not always have one (a routine, a Slack thread, a schedule), and the first way that goes wrong
 * is a skill written under the wrong name. Nothing is lost by it being here: authoring a skill is an
 * interview, so there is nobody to interview where there is no browser.
 *
 * WHY THEY ARE GATED ON THE GRANT. Four more tools on every run is not free — a model picks the right
 * tool reliably out of about ten, which is the whole reason per-run narrowing exists — and a Bot for
 * looking up transactions has no business drafting skills. So the gate is the ordinary one: the Bot
 * has to hold the `skill-creator` skill. Granting that skill is what turns a coworker into one you can
 * write skills with, and it is granted the same way everything else is.
 */

export function SkillTools() {
  // Grants are only fetched once a surface has declared its Bot; the placeholder is not one the
  // server knows, and asking would 404 on every poll.
  const declared = useDeclaredBotId();
  // Empty rather than undefined: the factory's own `enabled: agentId.length > 0` is the guard for
  // "no Bot declared yet", so the placeholder never reaches the server.
  const { data: granted } = useQuery(agentPluginsQueryOptions(declared ?? ""));
  const authoring = (granted?.skills ?? []).some(
    (skill) => skill.slug === SKILL_CREATOR_SLUG,
  );

  /*
   * The Plugins payload carries two of the three reads: every skill scoped to whoever is asking, and
   * every connected server's tools. It is the same query the Skills page runs, so a person who has
   * opened that page pays nothing for this — and it is not run at all on a Bot that cannot author
   * skills, which is most of them.
   */
  const { data: page } = useQuery({
    ...pluginsPageQueryOptions(),
    enabled: authoring,
  });
  const { data: me } = useQuery(currentUserQueryOptions());
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));

  const skills = page?.skills ?? [];

  useFrontendTool({
    name: "list_skills",
    description:
      "The skills that already exist in this deployment, one line each, with whose each one is. Read this before writing a skill: a slug is an identity, so reusing one replaces that skill, and a slug that is not the person's own cannot be replaced at all.",
    parameters: z.object({}),
    available: authoring,
    handler: async () => describeSkills(skills, me?.id),
  });

  useFrontendTool({
    name: "read_skill",
    description:
      "One existing skill in full, including its instructions. Use this when improving a skill rather than writing a new one — never rewrite an instruction you have not read.",
    parameters: z.object({
      slug: z
        .string()
        .describe(
          "The skill's `/` command, without the slash, as list_skills spells it.",
        ),
    }),
    available: authoring,
    handler: async ({ slug }) => {
      const wanted = String(slug).replace(/^\//, "");
      const skill = skills.find((candidate) => candidate.slug === wanted);
      if (!skill) {
        return `There is no skill called ${wanted} that this person can see. Call list_skills for the ones there are.`;
      }
      return describeSkill(skill);
    },
  });

  useFrontendTool({
    name: "list_skill_tools",
    description:
      "The `serverId/toolName` refs a skill here can declare, grouped by connector. Declaring a tool grants nothing — the offer a run gets is always the intersection of what the skill names with what the Bot was granted — so a skill may name tools for a connector this Bot does not hold yet.",
    parameters: z.object({}),
    available: authoring,
    handler: async () => describeToolRefs(page?.servers ?? []),
  });

  /**
   * The save, as a card rather than a handler.
   *
   * Stabilised with `useMemo` for the reason the gallery's decisions are: the render component is
   * identity-compared, and a fresh function every render remounts the card, which would reset the
   * pressed-Saving state and any refusal the server has just given it.
   */
  const Card = useMemo(
    () =>
      function ProposedSkillRender(props: {
        args: Partial<ProposedSkill>;
        respond?: (result: unknown) => Promise<void>;
        result?: string;
      }) {
        const slug = props.args.slug;
        const existing = slug
          ? skills.find((candidate) => candidate.slug === slug)
          : undefined;
        return (
          <ProposedSkillCard
            args={props.args}
            replaces={
              existing
                ? {
                    ownership: ownershipOf(existing, me?.id),
                    title: existing.title,
                  }
                : undefined
            }
            respond={props.respond}
            result={props.result}
            save={async (values: SkillFormValues) => {
              await saveSkill.mutateAsync({
                instructions: values.instructions,
                slug: values.slug,
                summary: values.summary,
                title: values.title,
                /*
                 * Sent on every save, including empty, because the server replaces the declared set
                 * rather than merging into it. See `SkillInput`.
                 */
                tools: values.tools,
              });
            }}
          />
        );
      },
    [me?.id, saveSkill, skills],
  );

  useHumanInTheLoop({
    name: "save_skill",
    description:
      "Put a finished skill in front of the person to save. They see the command, the title and the whole instruction, and nothing is written unless they press the button. Call this once, at the end, after they have agreed to what the skill says — not to check your draft.",
    parameters: proposedSkillSchema,
    available: authoring,
    render: Card,
  });

  return null;
}
