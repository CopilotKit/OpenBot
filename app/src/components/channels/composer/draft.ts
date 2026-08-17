import {
  getChipsByTrigger,
  isSegmentsEmpty,
  mergeAdjacentTextSegments,
  type Segment,
  segmentsToPlainText,
  text,
} from "prompt-area/helpers";

/**
 * Pure boundary between prompt-area segments and OpenBot's message draft model.
 */

export const AGENT_TRIGGER = "@";
export const COMMAND_TRIGGER = "/";

export type ComposerDraft = {
  /** Plain text, with chips flattened back to `@Agent` / `/command`. */
  text: string;
  /**
   * The single agent this message is addressed to, or `null` to let the channel pick its default.
   *
   * Exactly one responding agent per message, which is enforced on the
   * way in by `enforceSingleAgent` rather than validated here.
   */
  agentId: string | null;
  /** Commands that survive into the sent message, in the order they were typed. */
  commandIds: string[];
  isEmpty: boolean;
};

export function toDraft(segments: Segment[]): ComposerDraft {
  const agentChips = getChipsByTrigger(segments, AGENT_TRIGGER);
  const commandChips = getChipsByTrigger(segments, COMMAND_TRIGGER);

  return {
    text: segmentsToPlainText(segments).trim(),
    agentId: agentChips.at(-1)?.value ?? null,
    commandIds: commandChips.map((chip) => chip.value),
    isEmpty: isSegmentsEmpty(segments),
  };
}

/** Collapse multiple agent mentions to the most recent one while preserving identity on no-op. */
export function enforceSingleAgent(segments: Segment[]): Segment[] {
  const agentChipCount = getChipsByTrigger(segments, AGENT_TRIGGER).length;
  if (agentChipCount <= 1) {
    return segments;
  }

  let remaining = agentChipCount;
  const kept = segments.filter((segment) => {
    if (segment.type !== "chip" || segment.trigger !== AGENT_TRIGGER) {
      return true;
    }
    remaining -= 1;
    return remaining === 0;
  });

  return mergeAdjacentTextSegments(kept);
}

/**
 * What a `/command` does once it has been picked from the dropdown.
 *
 * - `chip` keeps the chip in the message, so the runtime receives it as structured data.
 * - `prompt` expands into editable text, for the channel's seeded suggested prompts.
 * - `action` runs client-side and never reaches the runtime.
 *
 * prompt-area always resolves a dropdown selection into a chip, so `prompt` and `action` are
 * applied here on the next change instead of being special-cased inside the editor.
 */
export type CommandKind = "chip" | "prompt" | "action";

export type CommandOption = {
  id: string;
  name: string;
  description?: string;
  /** Defaults to `chip`. */
  kind?: CommandKind;
  /** Text substituted for the command when `kind` is `prompt`. */
  prompt?: string;
  /** Side effect run when `kind` is `action`. */
  run?: () => void;
};

export type AppliedCommands = {
  segments: Segment[];
  /** Actions to run after the new segments are committed to state. */
  actions: (() => void)[];
};

/**
 * Rewrites `prompt` and `action` command chips, leaving `chip` commands (and everything else)
 * alone. Side effects are returned rather than run so the transform stays pure and testable.
 */
export function applyCommandChips(
  segments: Segment[],
  commands: readonly CommandOption[],
): AppliedCommands {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const actions: (() => void)[] = [];
  let changed = false;

  const rewritten = segments.flatMap<Segment>((segment) => {
    if (segment.type !== "chip" || segment.trigger !== COMMAND_TRIGGER) {
      return [segment];
    }

    const command = byId.get(segment.value);
    const kind = command?.kind ?? "chip";

    if (kind === "prompt") {
      changed = true;
      return command?.prompt ? [text(command.prompt)] : [];
    }

    if (kind === "action") {
      changed = true;
      if (command?.run) {
        actions.push(command.run);
      }
      return [];
    }

    return [segment];
  });

  return {
    segments: changed ? mergeAdjacentTextSegments(rewritten) : segments,
    actions,
  };
}
