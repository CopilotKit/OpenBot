import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, GalleryFrame } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  describeOutcomes,
  putSkillsOnBot,
  type SkillOutcome,
  saveSkills,
} from "@/lib/skills/import";
import {
  checkProposal,
  type ProposedSkill,
  skillsCardAnswer,
} from "@/lib/skills/proposal";
import { skillListQueryOptions } from "@/lib/skills/queries";
import {
  GitHubImport,
  type ListedSkill,
  SkillChecklist,
  SkillOutcomes,
  useStartingPicks,
} from "./import-skills";

/**
 * The cards a Bot puts in front of the person to bring in several skills at once, and to put skills on
 * itself. Like `ProposedSkillCard`, each one is the whole tool: the run waits on it, and nothing is
 * saved or changed until the person presses its button.
 */

type CardProps<Args> = {
  /** Partial while the model is still streaming the arguments. */
  args: Partial<Args>;
  /** Answering resumes the Bot. Absent while streaming, and once the card has been answered. */
  respond?: (result: unknown) => Promise<void>;
  /** The recorded answer, once there is one. */
  result?: string;
};

/** The Bot this conversation is with: its id and name, and whether OpenBot puts every skill on it. */
function useThisBot(): {
  id: string | undefined;
  name: string;
  personal: boolean;
} {
  const id = useDeclaredBotId();
  const { data: bots } = useQuery(agentListQueryOptions());
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const name = bots?.find((bot) => bot.id === id)?.name ?? "this Bot";
  return { id, name, personal };
}

/** Resuming a run that's no longer there isn't worth reporting: nothing is left to answer. */
function answer(
  respond: (result: unknown) => Promise<void>,
  sentence: string,
): Promise<void> {
  return respond(sentence).catch(() => {});
}

function Answered({ title, result }: { title: string; result: string }) {
  return (
    <GalleryFrame action={<Badge tone="neutral">Done</Badge>} title={title}>
      <p className="text-sm">{result}</p>
    </GalleryFrame>
  );
}

/** `import_skills_from_github`: the repository's skills, read at once, to tick and import. */
export function ImportSkillsCard({
  args,
  respond,
  result,
}: CardProps<{ repository: string }>) {
  const bot = useThisBot();
  const title = "Import skills from GitHub";
  if (result !== undefined) return <Answered result={result} title={title} />;
  if (!respond || !args.repository)
    return (
      <GalleryFrame title={title}>
        <p className="text-muted-foreground text-sm">Getting ready…</p>
      </GalleryFrame>
    );
  const putOn = bot.id && !bot.personal;
  return (
    <GalleryFrame
      action={<Badge tone="caution">Waiting on you</Badge>}
      caption="Nothing is saved until you choose which to import."
      title={title}
    >
      <GitHubImport
        botIds={putOn && bot.id ? [bot.id] : []}
        findAtOnce
        onCancel={() => void answer(respond, skillsCardAnswer.declined())}
        onDone={(outcomes) =>
          void answer(
            respond,
            skillsCardAnswer.done(
              describeOutcomes(outcomes, putOn ? bot.name : undefined),
            ),
          )
        }
        {...(putOn ? { putOnLabel: `Put them on ${bot.name}` } : {})}
        repository={args.repository}
      />
    </GalleryFrame>
  );
}

/** `save_skills`: several skills a Bot drafted, to tick and save with one press. */
export function ProposedSkillsCard({
  args,
  respond,
  result,
}: CardProps<{ skills: ProposedSkill[] }>) {
  const queryClient = useQueryClient();
  const bot = useThisBot();
  const [putOn, setPutOn] = useState(true);
  const drafts = (args.skills ?? []).map((draft) => ({
    draft,
    checked: checkProposal(draft),
  }));
  const listed: ListedSkill[] | undefined = respond
    ? drafts.map(({ draft, checked }, index) =>
        checked.ok
          ? { ...checked.values, summary: checked.values.summary ?? "" }
          : {
              slug: draft.slug ?? `skill-${index + 1}`,
              title: draft.title ?? "A skill",
              summary: draft.summary ?? "",
              instructions: draft.instructions ?? "",
              problem: checked.problems.join(" "),
            },
      )
    : undefined;
  const [picked, pick] = useStartingPicks(listed);
  const offerPutOn = Boolean(bot.id) && !bot.personal;
  const save = useMutation({
    mutationFn: (chosen: ListedSkill[]) =>
      saveSkills(queryClient, chosen, {
        botIds: offerPutOn && putOn && bot.id ? [bot.id] : [],
      }),
  });
  const title = "Save skills";
  if (result !== undefined) return <Answered result={result} title={title} />;
  if (!respond || !listed)
    return (
      <GalleryFrame title={title}>
        <p className="text-muted-foreground text-sm">Writing the skills…</p>
      </GalleryFrame>
    );

  const chosen = listed.filter((skill) => picked.has(skill.slug));
  const done = async (outcomes: SkillOutcome[]) =>
    answer(
      respond,
      skillsCardAnswer.done(
        describeOutcomes(outcomes, offerPutOn && putOn ? bot.name : undefined),
      ),
    );

  return (
    <GalleryFrame
      action={<Badge tone="caution">Waiting on you</Badge>}
      caption="Nothing is saved until you say so."
      title={title}
    >
      <div className="grid gap-3">
        <SkillChecklist
          disabled={save.isPending || save.isSuccess}
          onPick={pick}
          picked={picked}
          showInstructions
          skills={listed}
        />
        {save.data ? <SkillOutcomes outcomes={save.data} /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {offerPutOn ? (
            <Label className="flex items-center gap-2 font-normal text-sm">
              <Checkbox
                checked={putOn}
                disabled={save.isPending || save.isSuccess}
                onCheckedChange={(on) => setPutOn(Boolean(on))}
              />
              Put them on {bot.name}
            </Label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {save.data ? (
              <Button
                onClick={() => save.data && void done(save.data)}
                size="sm"
              >
                Done
              </Button>
            ) : (
              <>
                <Button
                  disabled={save.isPending}
                  onClick={() =>
                    void answer(respond, skillsCardAnswer.declined())
                  }
                  size="sm"
                  variant="outline"
                >
                  Don't save
                </Button>
                <Button
                  disabled={save.isPending || chosen.length === 0}
                  onClick={() => save.mutate(chosen)}
                  size="sm"
                >
                  {save.isPending
                    ? "Saving…"
                    : `Save ${chosen.length} skill${chosen.length === 1 ? "" : "s"}`}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </GalleryFrame>
  );
}

/** `add_skills_to_bot`: skills already saved, to put on the Bot this conversation is with. */
export function AddSkillsCard({
  args,
  respond,
  result,
}: CardProps<{ skills: string[] }>) {
  const queryClient = useQueryClient();
  const bot = useThisBot();
  const { data: skills } = useQuery(skillListQueryOptions());
  const put = useMutation({
    mutationFn: (slugs: string[]) =>
      bot.id ? putSkillsOnBot(queryClient, slugs, bot.id) : Promise.resolve([]),
  });
  const title = `Put skills on ${bot.name}`;
  if (result !== undefined) return <Answered result={result} title={title} />;
  if (!respond || !args.skills)
    return (
      <GalleryFrame title={title}>
        <p className="text-muted-foreground text-sm">Getting ready…</p>
      </GalleryFrame>
    );

  const slugs = [
    ...new Set(args.skills.map((slug) => slug.replace(/^\//, "").trim())),
  ];
  const known = slugs.filter((slug) =>
    skills?.some((skill) => skill.slug === slug),
  );
  const unknown = skills ? slugs.filter((slug) => !known.includes(slug)) : [];
  const already = (slug: string) =>
    skills
      ?.find((skill) => skill.slug === slug)
      ?.grantedTo.includes(bot.id ?? "") ?? false;

  const go = async () => {
    const results = await put.mutateAsync(known);
    const on = results.filter((one) => !one.problem).map((one) => one.slug);
    const problems = results
      .filter((one) => one.problem)
      .map((one) => `/${one.slug} isn't on it: ${one.problem}`);
    await answer(
      respond,
      skillsCardAnswer.put(bot.name, on, [
        ...problems,
        ...unknown.map((slug) => `There's no skill called /${slug}.`),
      ]),
    );
  };

  return (
    <GalleryFrame
      action={<Badge tone="caution">Waiting on you</Badge>}
      caption={
        bot.personal
          ? "In OpenBot Personal a new skill is on every Bot already. This puts back any that were turned off for it."
          : "Nothing changes until you say so."
      }
      title={title}
    >
      <ul className="grid gap-1 text-sm">
        {known.map((slug) => {
          const skill = skills?.find((one) => one.slug === slug);
          return (
            <li className="flex flex-wrap items-baseline gap-x-2" key={slug}>
              <span className="font-medium">{skill?.title ?? slug}</span>
              <span className="font-mono text-muted-foreground text-xs">
                /{slug}
              </span>
              {already(slug) ? (
                <span className="text-muted-foreground text-xs">
                  Already on it
                </span>
              ) : null}
            </li>
          );
        })}
        {unknown.map((slug) => (
          <li className="text-destructive text-xs" key={slug}>
            There's no skill called /{slug}.
          </li>
        ))}
      </ul>
      {!bot.id ? (
        <p className="mt-2 text-destructive text-sm">
          Open a conversation with the Bot first.
        </p>
      ) : null}
      {put.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {put.error.message}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          disabled={put.isPending}
          onClick={() => void answer(respond, skillsCardAnswer.declined())}
          size="sm"
          variant="outline"
        >
          Don't change
        </Button>
        <Button
          disabled={put.isPending || known.length === 0 || !bot.id}
          onClick={() => void go()}
          size="sm"
        >
          {put.isPending ? "Putting them on…" : `Put them on ${bot.name}`}
        </Button>
      </div>
    </GalleryFrame>
  );
}
