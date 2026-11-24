import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  findSkillsOnGitHub,
  type GitHubSkills,
  type SkillOutcome,
  type SkillToSave,
  saveSkills,
  slugStatus,
} from "@/lib/skills/import";
import { skillListQueryOptions } from "@/lib/skills/queries";
import { cn } from "@/lib/utils";

/**
 * Importing several skills at once: the list to tick, and the panel that finds them on GitHub. The
 * Skills page shows the panel in a dialog; a Bot shows it, or the list alone, as a card in chat.
 */

/** A skill on the list: what it would be saved as, and what to say about it. */
export type ListedSkill = SkillToSave & {
  /** Files the import can't bring along. */
  leftOut?: string[];
  /** Why it can't be saved as it is. */
  problem?: string | null;
};

/** The skills that may be ticked: none with a problem, and none another person has the command for. */
export function pickable(
  skill: ListedSkill,
  status: ReturnType<typeof slugStatus>,
): boolean {
  return !skill.problem && status !== "theirs";
}

/** A list of skills to tick, each saying what saving it would do. */
export function SkillChecklist({
  skills,
  picked,
  onPick,
  disabled = false,
  showInstructions = false,
}: {
  skills: readonly ListedSkill[];
  picked: ReadonlySet<string>;
  onPick: (slug: string, on: boolean) => void;
  disabled?: boolean;
  /** Each skill's instructions, folded, as a Bot's draft is worth reading before it's saved. */
  showInstructions?: boolean;
}) {
  const { data: existing } = useQuery(skillListQueryOptions());
  const { data: me } = useQuery(currentUserQueryOptions());
  return (
    <ul className="grid max-h-80 gap-1 overflow-y-auto rounded-md border border-border p-1">
      {skills.map((skill) => {
        const status = slugStatus(skill.slug, existing, me?.id);
        const can = pickable(skill, status);
        const id = `skill-${skill.slug}`;
        return (
          <li
            className={cn(
              "flex items-start gap-3 rounded-md px-2 py-2",
              can && "hover:bg-muted/50",
            )}
            key={skill.slug}
          >
            <Checkbox
              aria-labelledby={id}
              checked={picked.has(skill.slug)}
              className="mt-0.5"
              disabled={disabled || !can}
              onCheckedChange={(on) => onPick(skill.slug, Boolean(on))}
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium" id={id}>
                  {skill.title}
                </span>
                <span className="font-mono text-muted-foreground text-xs">
                  /{skill.slug}
                </span>
                {status === "yours" ? (
                  <span className="text-muted-foreground text-xs">
                    Replaces yours
                  </span>
                ) : null}
              </p>
              {skill.summary ? (
                <p className="line-clamp-2 text-muted-foreground text-xs">
                  {skill.summary}
                </p>
              ) : null}
              {skill.problem ? (
                <p className="text-destructive text-xs">{skill.problem}</p>
              ) : status === "theirs" ? (
                <p className="text-destructive text-xs">
                  Another skill already uses /{skill.slug}.
                </p>
              ) : null}
              {showInstructions && skill.instructions ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground text-xs">
                    Instructions
                  </summary>
                  <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                    {skill.instructions}
                  </p>
                </details>
              ) : null}
              {skill.leftOut && skill.leftOut.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {leftOutLine(skill.leftOut)}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function leftOutLine(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` and ${files.length - 3} more` : "";
  return `Leaves out ${files.length === 1 ? "1 file" : `${files.length} files`}: ${shown}${more}.`;
}

/** The ticks a list starts with: every skill that can be saved. */
export function useStartingPicks(
  skills: readonly ListedSkill[] | undefined,
): [Set<string>, (slug: string, on: boolean) => void, (all: boolean) => void] {
  const { data: existing } = useQuery(skillListQueryOptions());
  const { data: me } = useQuery(currentUserQueryOptions());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Seeded once per list, known by its commands: callers build the list afresh on every render.
  const seeded = useRef<string | undefined>(undefined);
  const key = skills?.map((skill) => skill.slug).join("\n");
  const can = (skill: ListedSkill) =>
    pickable(skill, slugStatus(skill.slug, existing, me?.id));
  useEffect(() => {
    if (!skills || key === undefined || seeded.current === key || !existing)
      return;
    seeded.current = key;
    setPicked(new Set(skills.filter(can).map((skill) => skill.slug)));
  });
  const pick = (slug: string, on: boolean) =>
    setPicked((now) => {
      const next = new Set(now);
      if (on) next.add(slug);
      else next.delete(slug);
      return next;
    });
  const all = (on: boolean) =>
    setPicked(
      on
        ? new Set((skills ?? []).filter(can).map((skill) => skill.slug))
        : new Set(),
    );
  return [picked, pick, all];
}

/** What an import did, skill by skill, once it's done. */
export function SkillOutcomes({
  outcomes,
}: {
  outcomes: readonly SkillOutcome[];
}) {
  const saved = outcomes.filter((outcome) => outcome.saved);
  const refused = outcomes.filter((outcome) => !outcome.saved);
  const offBot = saved.filter(
    (outcome) => outcome.saved && outcome.onBot === false,
  );
  return (
    <div className="grid gap-1 text-sm" role="status">
      <p>
        {saved.length === 0
          ? "Nothing was saved."
          : `Saved ${saved.length} skill${saved.length === 1 ? "" : "s"}. Type / in a conversation to use them.`}
      </p>
      {offBot.map((outcome) =>
        outcome.saved ? (
          <p className="text-destructive text-xs" key={outcome.slug}>
            /{outcome.slug} is saved but not on the Bot. {outcome.note}
          </p>
        ) : null,
      )}
      {refused.map((outcome) =>
        outcome.saved ? null : (
          <p className="text-destructive text-xs" key={outcome.slug}>
            /{outcome.slug} wasn't saved. {outcome.reason}
          </p>
        ),
      )}
    </div>
  );
}

/** A GitHub skill as the list shows it. */
function listed(found: GitHubSkills): ListedSkill[] {
  return found.skills.map((skill) => ({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
    leftOut: skill.leftOut,
    problem: skill.problem,
  }));
}

/**
 * Find the skills in a GitHub repository, tick the ones to keep, and import them. Saved as the person,
 * then put on `botIds` when there are any.
 */
export function GitHubImport({
  repository: given = "",
  findAtOnce = false,
  botIds = [],
  putOnLabel,
  onCancel,
  onDone,
}: {
  repository?: string;
  /** Read the given repository as soon as this shows, as a Bot's card does. */
  findAtOnce?: boolean;
  /** The Bots to put the imported skills on, when the person leaves `putOnLabel` ticked. */
  botIds?: readonly string[];
  /** The tick that puts them on `botIds`, such as "Put them on Personal Assistant". Absent: no tick. */
  putOnLabel?: string;
  onCancel?: () => void;
  onDone?: (outcomes: SkillOutcome[]) => void;
}) {
  const queryClient = useQueryClient();
  const repositoryId = useId();
  const [repository, setRepository] = useState(given);
  const [putOn, setPutOn] = useState(true);
  const [progress, setProgress] = useState(0);
  const find = useMutation({ mutationFn: findSkillsOnGitHub });
  const found = find.data;
  const skills = found ? listed(found) : undefined;
  const [picked, pick, pickAll] = useStartingPicks(skills);
  const importing = useMutation({
    mutationFn: (chosen: ListedSkill[]) =>
      saveSkills(queryClient, chosen, {
        botIds: putOnLabel && putOn ? botIds : [],
        onProgress: setProgress,
      }),
    onSuccess: (outcomes) => onDone?.(outcomes),
  });
  const started = useRef(false);
  useEffect(() => {
    if (!findAtOnce || started.current || !given.trim()) return;
    started.current = true;
    find.mutate(given);
  }, [findAtOnce, given, find]);

  const chosen = (skills ?? []).filter((skill) => picked.has(skill.slug));
  const busy = find.isPending || importing.isPending;

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (repository.trim()) find.mutate(repository);
        }}
      >
        <Label htmlFor={repositoryId}>GitHub repository</Label>
        <div className="flex gap-2">
          <Input
            disabled={busy || importing.isSuccess}
            id={repositoryId}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repo"
            value={repository}
          />
          <Button
            disabled={busy || importing.isSuccess || !repository.trim()}
            size="sm"
            type="submit"
            variant="outline"
          >
            {find.isPending ? "Finding…" : "Find skills"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          A public repository, or a folder in one. Each folder with a SKILL.md
          becomes a skill.
        </p>
      </form>

      {find.error ? (
        <p className="text-destructive text-sm" role="alert">
          {find.error.message}
        </p>
      ) : null}

      {found && skills ? (
        skills.length === 0 ? (
          <p className="text-sm">
            {found.repository} has no SKILL.md files. Check the repository or
            folder.
          </p>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm">
                Found {skills.length} skill{skills.length === 1 ? "" : "s"} in{" "}
                {found.repository}.
                {found.notRead > 0
                  ? ` ${found.notRead} more weren't read.`
                  : ""}
              </p>
              {importing.isSuccess ? null : (
                <Button
                  disabled={busy}
                  onClick={() => pickAll(chosen.length === 0)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {chosen.length === 0 ? "Select all" : "Select none"}
                </Button>
              )}
            </div>
            <SkillChecklist
              disabled={busy || importing.isSuccess}
              onPick={pick}
              picked={picked}
              skills={skills}
            />
            <p className="text-muted-foreground text-xs">
              Only each SKILL.md comes across. A skill here is its instructions,
              so files beside it are left out.
            </p>
          </div>
        )
      ) : null}

      {importing.data ? <SkillOutcomes outcomes={importing.data} /> : null}
      {importing.isSuccess && onCancel ? (
        <div className="flex justify-end">
          <Button onClick={onCancel} size="sm" type="button">
            Done
          </Button>
        </div>
      ) : null}

      {skills && skills.length > 0 && !importing.isSuccess ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {putOnLabel ? (
            <Label className="flex items-center gap-2 text-sm font-normal">
              <Checkbox
                checked={putOn}
                disabled={busy}
                onCheckedChange={(on) => setPutOn(Boolean(on))}
              />
              {putOnLabel}
            </Label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {onCancel ? (
              <Button
                disabled={importing.isPending}
                onClick={onCancel}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            ) : null}
            <Button
              disabled={busy || chosen.length === 0}
              onClick={() => importing.mutate(chosen)}
              size="sm"
              type="button"
            >
              {importing.isPending
                ? `Importing ${Math.min(progress + 1, chosen.length)} of ${chosen.length}…`
                : `Import ${chosen.length} skill${chosen.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
