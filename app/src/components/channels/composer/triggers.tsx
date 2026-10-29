import type { TriggerConfig, TriggerSuggestion } from "prompt-area/helpers";
import { commandTrigger, mentionTrigger } from "prompt-area/helpers";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AGENT_TRIGGER, COMMAND_TRIGGER, type CommandOption } from "./draft";

/**
 * The composer's trigger registry.
 *
 * Adding a trigger means adding a factory here and passing its source down; composer rendering stays
 * independent of trigger semantics.
 */

export type AgentOption = {
  id: string;
  name: string;
  description?: string;
  avatarSeed: string;
};

/**
 * Narrows the agent roster to mention options, scoped to a channel's permitted agents when
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
      description: profile.title,
      // A group's roster carries no seed, and draws each Bot from its id; this matches it.
      avatarSeed: profile.avatarSeed ?? profile.id,
    }));
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * `@` selects the agent that answers this message.
 *
 * `reopenOnChipClick` keeps an inserted mention editable without deleting and retyping.
 */
export function agentTrigger(agents: readonly AgentOption[]): TriggerConfig {
  return mentionTrigger({
    char: AGENT_TRIGGER,
    accessibilityLabel: "Bot",
    reopenOnChipClick: true,
    emptyMessage: "No Bots in this conversation",
    onSearch: (query): TriggerSuggestion[] =>
      agents
        .filter((agent) => matches(query, agent.name, agent.description))
        .map((agent) => ({
          value: agent.id,
          label: agent.name,
          description: agent.description,
          // Hidden: the option is already announced by the Bot's name.
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
        .filter((command) => matches(query, command.name, command.description))
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
