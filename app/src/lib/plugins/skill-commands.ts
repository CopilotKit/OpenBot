import type { UseQueryResult } from "@tanstack/react-query";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

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
     * The chip stays, one token wide, and is sent as `/<command>` at the start of the message. The
     * server finds it there and gives the Bot the skill's stored instructions, only for a skill
     * that Bot holds (server/src/plugins/picked-skill.ts). Nothing is hidden by this that was not
     * already: the instruction is the skill's own text, visible on the skills page, and a skill is
     * an instruction rather than a capability — it can only ask for tools the Bot already holds.
     */
    kind: "chip",
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
