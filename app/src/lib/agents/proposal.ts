import { z } from "zod";
import type { PluginSkill } from "@/lib/plugins/queries";
import { type AgentFormValues, agentFormSchema } from "./form";
import type { AgentProfile } from "./queries";

/**
 * A coworker a Bot proposes during a conversation, and the checks it goes through before anybody is
 * asked to approve it.
 *
 * WHY A SEPARATE SHAPE FROM THE FORM'S. `form.ts` describes what a person typed into five fields; a
 * model hands over three of them as arguments it may have got wrong in ways a form cannot — a name
 * the length of a paragraph, a role description that runs past the limit, `skills` arriving as a
 * lone string. So the model-facing schema is permissive about types and the checking is done
 * afterwards, against the same `agentFormSchema` the New coworker form uses. A Bot making a coworker
 * and a person making one are then held to one rule, with no second parser to drift from the
 * server's.
 *
 * Nothing here decides whether the coworker may be created. That stays the server's: `POST
 * /api/agents` already answers who may, records `bot.created`, and refuses in its own words.
 */

/**
 * What the card answers its tool call with, and the facts it reads back out.
 *
 * WHY THESE ARE HERE AND NOT ON THE CARD. A completed card has only the result string to go on — the
 * SDK hands back what the tool answered, not what happened — so whether to offer the link to the new
 * coworker is decided by reading the sentence. Written on the card, the sentence and its reader
 * would be two literals a reword could silently separate, and the failure is a link that quietly
 * stops appearing.
 *
 * The sentences are addressed to the model, because that is who receives them, and each says what to
 * do next: a tool result that only reports state leaves the Bot guessing whether the turn is over.
 */
const CREATED_MARKER = "Created.";

export const botCardAnswer = {
  created: (input: {
    agentId: string;
    name: string;
    granted: readonly string[];
    failed: readonly string[];
  }) => {
    const parts = [
      `${CREATED_MARKER} ${input.name} now exists and is private.`,
    ];
    if (input.granted.length > 0) {
      parts.push(`It holds ${input.granted.map((s) => `/${s}`).join(", ")}.`);
    }
    /*
     * Said out loud rather than rounded up. Creating and granting are two calls, so a grant that
     * fails after the coworker exists leaves it with fewer skills than the person agreed to — and a
     * Bot that reported the whole set would send somebody away believing in a skill that is not
     * there.
     */
    if (input.failed.length > 0) {
      parts.push(
        `${input.failed.map((s) => `/${s}`).join(", ")} could not be put on it; tell the person to add ${input.failed.length === 1 ? "it" : "them"} from the coworker's profile.`,
      );
    }
    parts.push(
      "It was granted no connector, no tool and no address. Tell the person that anything it needs to reach is granted on its profile, that it can be talked to now, and that its profile is at",
      `/agents?agent=${input.agentId}.`,
    );
    return parts.join(" ");
  },
  declined: () =>
    "The person did not create this coworker. Ask what to change rather than proposing the same one again.",
  /** A proposal the fields refuse, answered rather than shown as a question. See the card. */
  unwritable: (problems: readonly string[]) =>
    `Not created, and the person was not asked, because the coworker is not valid: ${problems.join(" ")} Fix those and propose it again.`,
};

/** Whether a completed card's recorded answer is one that made a coworker. */
export function wasCreated(result: string): boolean {
  return result.startsWith(CREATED_MARKER);
}

/**
 * The coworker a completed card made, read back out of its own answer.
 *
 * WHY IT IS PARSED RATHER THAN REMEMBERED. A card is re-rendered from the transcript on every
 * reload, with the arguments and the recorded answer and nothing else — component state does not
 * survive it. The id is minted by the server, so unlike a skill's slug it is not in the arguments,
 * and a card that kept it in `useState` would show the link once and then quietly stop showing it to
 * anybody who refreshed. Putting it in the sentence is also the honest thing for the model, which is
 * being told where the coworker it just made can be found.
 *
 * Paired with {@link botCardAnswer.created} here, in one module, and pinned by a test, because a
 * reworded sentence and a reader living apart is exactly how a link stops appearing with nothing to
 * say why.
 */
export function createdBotIdIn(result: string): string | null {
  return /agent=([A-Za-z0-9_-]+)/.exec(result)?.[1] ?? null;
}

/**
 * The skill whose grant turns a Bot into one you can make coworkers with.
 *
 * The app offers `save_bot` and the reads beside it only while the active Bot holds this slug, and
 * the shipped package is what puts the slug in the deployment and on a Bot. So the two have to
 * agree: rename it in one place and making a coworker in a conversation stops working, with nothing
 * on screen to say why and a deployment that still looks healthy. `bot-creator-slug.test.ts` is the
 * guard, which is why this lives in a module with no React in it rather than beside the hooks.
 *
 * Not an MCP ref, and deliberately not declared in `skills.yaml`'s `tools:`. A declaration there is
 * intersected with the Bot's MCP grants, so naming the app's own tools would name nothing.
 */
export const BOT_CREATOR_SLUG = "bot-creator";

/**
 * The arguments the model is offered, described for the model rather than for us.
 *
 * Every `describe` is read by the thing filling the field in, so they say what good looks like
 * instead of restating the type. The role description gets the longest one because it is the field
 * that decides what the coworker actually is: on a deployment with no Bot of its own it becomes the
 * standing instruction the coworker runs on, which is a different job from writing a summary of it.
 */
export const proposedBotSchema = z.object({
  name: z
    .string()
    .describe(
      "What the coworker is called, as a person would say it: `Renewal Desk`, not `renewal_desk_bot`. Up to 80 characters.",
    ),
  title: z
    .string()
    .describe(
      "The job it does, the way a job title reads: `Accounts Receivable`, `Support Operations`. Up to 120 characters. This is given to the model on every turn, so it is part of what the coworker is rather than a label.",
    ),
  roleDescription: z
    .string()
    .describe(
      "The coworker's standing instructions, written as directions to it in the imperative, up to 1000 characters. Say what it does, what it must not conclude, and what it says when the evidence is thin. This text is given to a model on every turn in every channel, so write the rules that should always hold rather than a description of the coworker in the third person. Do not address the person talking to it.",
    ),
  skills: z
    .array(z.string())
    .optional()
    .describe(
      "Slugs of skills that already exist here to put on this coworker, from list_bot_skills, without the slash. This is the only capability the card grants, and it grants nothing else: no connector, no tool and no address. Omit for a coworker that is only its instructions, which is most of them.",
    ),
});

export type ProposedBot = z.infer<typeof proposedBotSchema>;

/** What checking a proposal answers with: the values to create, or the problems to fix. */
export type CheckedBot =
  | { ok: true; values: AgentFormValues; skills: string[] }
  | { ok: false; problems: string[] };

/**
 * Hold a proposal to the same rule the New coworker form is held to.
 *
 * Checked here rather than left to the server because the alternative is a person being shown a card
 * for a coworker that cannot be created, pressing the button, and reading a validation message as
 * though they had done something wrong. A problem the model can fix should reach the model.
 *
 * The three fields the model does not supply are fixed rather than offered. `visibility` is private
 * because a coworker somebody has not read yet has no business on everybody's roster, and making it
 * public is one control on its profile. `endpoint` and `authValue` are empty because the card cannot
 * point a coworker at a host: with no address the server binds it in-process on the role description
 * above, which is the whole reason this interview can end without asking somebody for a URL.
 */
export function checkProposal(args: {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  skills?: unknown;
}): CheckedBot {
  const parsed = agentFormSchema.safeParse({
    name: typeof args.name === "string" ? args.name : "",
    title: typeof args.title === "string" ? args.title : "",
    roleDescription:
      typeof args.roleDescription === "string" ? args.roleDescription : "",
    visibility: "private",
    endpoint: "",
    authValue: "",
  });
  if (parsed.success) {
    return { ok: true, skills: skillSlugsIn(args.skills), values: parsed.data };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    }),
  };
}

/**
 * Skill slugs out of whatever the model sent, keeping the strings and a lone string on its own.
 *
 * Anything else is dropped rather than refused: a model that answers `skills: "find-a-document"`
 * meant the one skill, and a refusal here would send it back to redo a whole proposal over a comma.
 * A coworker holding no skills is always valid.
 */
export function skillSlugsIn(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return [];
  return list
    .filter((slug): slug is string => typeof slug === "string")
    .map((slug) => slug.trim().replace(/^\//, ""))
    .filter((slug) => slug.length > 0);
}

/**
 * Whose a coworker is, in the words the answer uses.
 *
 * Ownership rather than permission, and the distinction is the point: who may change a coworker is
 * the server's to decide, and what this says is the fact a model needs in order to describe the
 * roster accurately. `systemOwned` is checked first because a Bot that ships in the box is the
 * deployment's however it looks from here.
 */
export function ownershipOf(
  agent: Pick<AgentProfile, "systemOwned" | "mine">,
): "yours" | "the deployment's" | "somebody else's" {
  if (agent.systemOwned) return "the deployment's";
  return agent.mine ? "yours" : "somebody else's";
}

/**
 * The coworkers that already exist here, as the answer to `list_bots`.
 *
 * One line each, because the reason to ask is to find out whether the coworker being described is
 * already here — a rebuilt duplicate of a Bot somebody else maintains is the most expensive mistake
 * this interview can make, and the cheapest to avoid. The role descriptions are deliberately left
 * out: a dozen of them is most of a run, and a Bot comparing against one asks for it by name.
 */
export function describeBots(agents: readonly AgentProfile[]): string {
  if (agents.length === 0) {
    return "No coworkers exist here yet. Anything you propose is the first.";
  }
  const lines = agents.map((agent) => {
    const where = agent.endpoint ? "runs at its own address" : "runs here";
    return `- ${agent.name} — ${agent.title} (${ownershipOf(agent)}, ${where})`;
  });
  return [
    `${agents.length} coworker${agents.length === 1 ? "" : "s"} already exist here. If one of them already does the job being described, say so and offer that one instead of making a second.`,
    ...lines,
  ].join("\n");
}

/**
 * One coworker in full, including the instructions it runs on, for `read_bot`.
 *
 * Separate from {@link describeBots} so the expensive field is fetched deliberately, one coworker at
 * a time, by a Bot that has been asked to make something like it. Never paraphrase a role
 * description that has not been read: it is the only place a coworker's actual rules are written.
 */
export function describeBot(agent: AgentProfile): string {
  return [
    `${agent.name} — ${agent.title} (${ownershipOf(agent)})`,
    agent.endpoint
      ? "Runs at its own address, which a coworker made here cannot be given."
      : "Runs on this deployment, on the instructions below.",
    "Instructions:",
    agent.roleDescription,
  ].join("\n");
}

/**
 * The skills a new coworker could be given, as the answer to `list_bot_skills`.
 *
 * Every skill the person can see rather than the skills the ASKING Bot holds, and that is deliberate
 * rather than loose: what this Bot was granted says nothing about what the coworker being made
 * should hold. The person's own skills and the deployment's are both offered, because granting one
 * to a coworker is the same act either way.
 *
 * The instructions are left out for the same reason `list_bots` leaves out role descriptions, and
 * because nothing here is being edited: this list exists to pick from.
 */
export function describeGrantableSkills(
  skills: readonly PluginSkill[],
): string {
  if (skills.length === 0) {
    return "No skills exist here yet, so a coworker made now runs on its instructions alone. That is ordinary — most coworkers do.";
  }
  const lines = skills.map((skill) => {
    const parts = [`/${skill.slug} — ${skill.title}`];
    if (skill.summary) parts.push(skill.summary);
    if (skill.tools.length > 0) parts.push(`needs ${skill.tools.join(", ")}`);
    return `- ${parts.join(" · ")}`;
  });
  return [
    "Skills that can be put on a new coworker. A skill is an instruction, not a capability: one naming a tool the coworker was not granted loads nothing, so putting it on is safe and granting the connector is a separate step somebody takes on the profile.",
    ...lines,
  ].join("\n");
}
