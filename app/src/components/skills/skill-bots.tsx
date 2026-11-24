import { IconChevronDown } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { grantRoster } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  chooseSkillBotsMutationOptions,
  type SkillBots,
} from "@/lib/skills/mutations";
import type { Skill } from "@/lib/skills/queries";

/**
 * Which Bots use a skill, in OpenBot Personal: every Bot, Bots made later included, or only the ones
 * chosen. Choosing none leaves it on every Bot, so a skill is never left on no Bot from here. Taking
 * it from every Bot is deleting it, or switching it off on each Bot's page.
 */

type Bot = { id: string; name: string };

/** The Bots a skill can be put on: the roster, and any hidden Bot that holds it. */
export function useSkillBotRoster(holders: readonly string[] = []): Bot[] {
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: hidden } = useQuery(agentListQueryOptions(true));
  return grantRoster({
    roster: agents ?? [],
    hidden: hidden ?? [],
    holders,
  });
}

/** "Every Bot", "Coder", "Coder and Writer", "Coder and 2 more", or "No Bots". */
export function skillBotsSummary(
  skill: Pick<Skill, "everyBot" | "grantedTo">,
  bots: readonly Bot[],
): string {
  if (skill.everyBot) return "Every Bot";
  const names = bots
    .filter((bot) => skill.grantedTo.includes(bot.id))
    .map((bot) => bot.name);
  if (names.length === 0) return "No Bots";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/** What a set of picked Bots saves as: none picked is every Bot. */
export function botsFromPicks(picked: ReadonlySet<string>): SkillBots {
  return picked.size === 0
    ? { everyBot: true }
    : { everyBot: false, botIds: [...picked] };
}

/**
 * A button per Bot, filled when it's chosen, and a line saying what the choice means. None chosen
 * is every Bot.
 */
export function ChooseBots({
  bots,
  picked,
  onChange,
  disabled = false,
  what = "it",
}: {
  bots: readonly Bot[];
  picked: ReadonlySet<string>;
  onChange: (picked: Set<string>) => void;
  disabled?: boolean;
  /** What the Bots would use, for the line under the buttons: "it", or "them" for several skills. */
  what?: "it" | "them";
}) {
  const names = bots.filter((bot) => picked.has(bot.id)).map((bot) => bot.name);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {bots.map((bot) => {
          const on = picked.has(bot.id);
          return (
            <Button
              aria-pressed={on}
              disabled={disabled}
              key={bot.id}
              onClick={() => {
                const next = new Set(picked);
                if (on) next.delete(bot.id);
                else next.add(bot.id);
                onChange(next);
              }}
              size="sm"
              type="button"
              // Filled when chosen, so which are on survives a glance (as in `skill-agents.tsx`).
              variant={on ? "default" : "outline"}
            >
              {bot.name}
            </Button>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {names.length === 0
          ? `Every Bot uses ${what}, including Bots you make later. Choose Bots to use ${what} on only those.`
          : `Only ${listed(names)} ${names.length === 1 ? "uses" : "use"} ${what}. Choose none to use ${what} on every Bot.`}
      </p>
    </div>
  );
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A skill's Bots, as a button that opens the choice. */
export function SkillBotsButton({ skill }: { skill: Skill }) {
  const [open, setOpen] = useState(false);
  const bots = useSkillBotRoster(skill.grantedTo);
  return (
    <>
      <Button
        aria-label={`Bots for ${skill.title}: ${skillBotsSummary(skill, bots)}`}
        onClick={(event) => {
          // The row around it may be a link to the skill's page.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <span className="max-w-40 truncate text-muted-foreground text-xs">
          {skillBotsSummary(skill, bots)}
        </span>
        <IconChevronDown className="text-muted-foreground" />
      </Button>
      {open ? (
        <SkillBotsDialog
          bots={bots}
          onClose={() => setOpen(false)}
          skill={skill}
        />
      ) : null}
    </>
  );
}

/** Choose a skill's Bots in a dialog, saved with one press. */
export function SkillBotsDialog({
  skill,
  bots,
  onClose,
}: {
  skill: Skill;
  bots: readonly Bot[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(skill.everyBot ? [] : skill.grantedTo),
  );
  const save = useMutation({
    ...chooseSkillBotsMutationOptions(queryClient),
    onSuccess: onClose,
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bots for {skill.title}</DialogTitle>
          <DialogDescription>
            Choose which Bots use this skill. With none chosen, every Bot uses
            it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          {bots.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              You don't have a Bot yet. Every Bot you make will use it.
            </p>
          ) : (
            <ChooseBots
              bots={bots}
              disabled={save.isPending}
              onChange={setPicked}
              picked={picked}
            />
          )}
          {save.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ slug: skill.slug, bots: botsFromPicks(picked) })
            }
            size="sm"
            type="button"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
