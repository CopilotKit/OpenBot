import type { UseQueryResult } from "@tanstack/react-query";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

/**
 * The instructions behind a draft's `/` chips, in the order they were typed.
 *
 * Resolved against the same list the menu was built from, so a chip left over from a skill that has
 * since been revoked resolves to nothing rather than to a stale instruction. Shared by the two places
 * a message is first sent from, a conversation and `/channel/new`, so a skill means the same thing
 * on the first message as on every one after it.
 */
export function skillInstructionsFor(
  commandIds: readonly string[],
  commands: readonly CommandOption[],
): string[] {
  return commandIds
    .map((id) => commands.find((command) => command.id === id)?.prompt)
    .filter((instruction): instruction is string => Boolean(instruction));
}

/** One granted skill as a `/` menu command. */
function toCommand(skill: GrantedPlugins["skills"][number]): CommandOption {
  return {
    id: skill.slug,
    // Its name, not its command: the menu and the chip read as what the skill is called.
    name: skill.title || skill.slug,
    ...(skill.summary ? { description: skill.summary } : {}),
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
    kind: "chip",
    /*
     * Carried on the option rather than looked up again at send time. `applyCommandChips` only
     * substitutes `prompt` for `kind: "prompt"`, so on a chip this is inert payload, and the
     * alternative is a second query racing the first for the same rows.
     */
    prompt: skill.instructions,
  };
}

/**
 * Granted skills as `/` menu commands. Each one inserts a chip, not composer text.
 */
export function useSkillCommands(agentId: string): CommandOption[] {
  const { data } = useQuery(agentPluginsQueryOptions(agentId));

  return useMemo(() => (data?.skills ?? []).map(toCommand), [data]);
}

/**
 * Every skill any of these Bots offers, for a composer that has not picked its Bot yet: the home
 * page, where the Bot is chosen with `@` or routed to after sending.
 *
 * `botsFor` says which of them offer a skill, so a message that runs one goes to a Bot that has it.
 */
export function useAnyBotSkillCommands(agentIds: readonly string[]): {
  commands: CommandOption[];
  botsFor: (slug: string) => string[];
} {
  /*
   * Combined inside `useQueries`, which reruns this only when a Bot's skills or this function
   * change, so the composer's triggers are not rebuilt on every render. Keyed on the ids' text, since
   * the roster array itself is new on each render.
   */
  const key = agentIds.join(",");
  const combine = useCallback(
    (results: UseQueryResult<GrantedPlugins>[]) => {
      const ids = key.split(",");
      const commands = new Map<string, CommandOption>();
      const bots = new Map<string, string[]>();
      results.forEach((result, index) => {
        const agentId = ids[index];
        if (!agentId) return;
        for (const skill of result.data?.skills ?? []) {
          if (!commands.has(skill.slug))
            commands.set(skill.slug, toCommand(skill));
          bots.set(skill.slug, [...(bots.get(skill.slug) ?? []), agentId]);
        }
      });
      return {
        commands: [...commands.values()],
        botsFor: (slug: string) => bots.get(slug) ?? [],
      };
    },
    [key],
  );
  return useQueries({
    queries: agentIds.map((id) => agentPluginsQueryOptions(id)),
    combine,
  });
}
