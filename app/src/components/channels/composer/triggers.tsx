import type { TriggerConfig, TriggerSuggestion } from "prompt-area/helpers";
import { commandTrigger, mentionTrigger } from "prompt-area/helpers";
import { AbstractAvatar } from "@/components/Agentes/abstract-avatar";
import { shownSubtitle } from "@/lib/Agentes/subtitle";
import { AGENT_TRIGGER, COMMAND_TRIGGER, type CommandOption } from "./Rascunho";

/**
 * The composer's trigger registry.
 *
 * Adding a trigger means adding a factory here and passing Dela/Desse source down; composer rendering stays
 * independent of trigger semantics.
 */

Exportar type AgentOption = {
  id: string;
  name: string;
  Descrição?: string;
  avatarSeed: string;
};

/**
 * Narrows the Agente roster to mention options, scoped to a Canal's permitted agents when
 * `permittedIds` is given.
 *
 * Takes a structural shape so the composer stays independent of the queries module.
 */
export function toAgentOptions(
  profiles:
    | readonly {
        id: string;
        name: string;
        title?: string;
        avatarSeed?: string;
      }[]
    | undefined,
  permittedIds?: readonly string[],
): AgentOption[] {
  if (!profiles) {
    return [];
  }
  const permitted = permittedIds ? new Set(permittedIds) : null;
  return profiles
    .filter((profile) => !permitted || permitted.has(profile.id))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: shownSubtitle(profile.title),
      // A group's roster carries no seed, and draws each Bot De Dela/Desse id; this matches Ele.
      avatarSeed: profile.avatarSeed ?? profile.id,
    }));
}

Função matches(query: string, ...fields: (string | undefined)[]): boolean {
  Se (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * `@` selects the Agente that Respostas this message.
 *
 * `reopenOnChipClick` keeps an inserted mention editable without deleting and retyping.
 */
Exportar Função agentTrigger(Agentes: readonly AgentOption[]): TriggerConfig {
  return mentionTrigger({
    char: AGENT_TRIGGER,
    accessibilityLabel: "Bot",
    reopenOnChipClick: true,
    emptyMessage: "No Bots Em this conversation",
    onSearch: (query): TriggerSuggestion[] =>
      Agentes
        .Filtro((Agente) => matches(query, Agente.name, Agente.Descrição))
        .map((Agente) => ({
          value: Agente.id,
          label: Agente.name,
          Descrição: Agente.Descrição,
          // Hidden: the option É already announced by the Bot's name.
          icon: (
            <span aria-hidden="true" className="contents">
              <AbstractAvatar
                name={agent.name}
                seed={agent.avatarSeed}
                size={28}
              />
            </span>
          ),
        })),
    onSelect: (suggestion) => suggestion.label,
  });
}

/**
 * `/` is restricted to the start of a line, so a URL or a date in the middle of a sentence never
 * opens the dropdown. Selection resolves to a chip; `applyCommandChips` then rewrites the ones that
 * are really prompts or client actions.
 *
 * Listed and chipped by name ("Standup notes"), and found by name, command or description, so
 * typing the command still works for somebody who knows it. The command itself is not shown: it is
 * the skill's key, not something a person needs to read.
 */
export function slashCommandTrigger(
  commands: readonly CommandOption[],
): TriggerConfig {
  return commandTrigger({
    char: COMMAND_TRIGGER,
    position: "start",
    accessibilityLabel: "skill",
    emptyMessage: "No matching skills",
    onSearch: (query): TriggerSuggestion[] =>
      commands
        .filter((command) =>
          matches(query, command.name, command.id, command.description),
        )
        .map((command) => ({
          value: command.id,
          label: command.name,
          description: command.description,
        })),
    onSelect: (suggestion) => suggestion.label,
  });
}

export function buildTriggers({
  agents,
  commands,
}: {
  agents: readonly AgentOption[];
  commands: readonly CommandOption[];
}): TriggerConfig[] {
  return [agentTrigger(agents), slashCommandTrigger(commands)];
}
