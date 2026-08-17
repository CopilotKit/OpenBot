import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";

/**
 * Granted skills as `/` menu commands. Each one inserts a chip, not composer text.
 */
export function useSkillCommands(agentId: string): CommandOption[] {
  const { data } = useQuery(agentPluginsQueryOptions(agentId));

  return useMemo(
    () =>
      (data?.skills ?? []).map((skill) => ({
        id: skill.slug,
        name: skill.slug,
        description: skill.summary || skill.title,
        /*
         * A CHIP, NOT AN EXPANSION. `prompt` used to paste the skill's whole instruction into the
         * box, which meant a person watched a paragraph they did not write appear over the message
         * they were typing, and had to scroll past it to reach their own words.
         *
         * The chip stays, one token wide, and `channel-chat` reads `draft.commandIds` on send and
         * puts the instruction in front of the run. Nothing is hidden by this that was not already:
         * the instruction is the skill's own text, visible on the skills page, and a skill is an
         * instruction rather than a capability — it can only ask for tools the Bot already holds.
         */
        kind: "chip" as const,
        /*
         * Carried on the option rather than looked up again at send time. `applyCommandChips` only
         * substitutes `prompt` for `kind: "prompt"`, so on a chip this is inert payload, and the
         * alternative is a second query racing the first for the same rows.
         */
        prompt: skill.instructions,
      })),
    [data],
  );
}
