import {
  type SettingsToolCard,
  settingsArgs,
  settingsResult,
  settingsToolOf,
} from "./registry";
import { adminSettingsToolCards } from "./settings-tool-cards-admin";
import { coreSettingsToolCards } from "./settings-tool-cards-core";
import { personalSettingsToolCards } from "./settings-tool-cards-personal";

/** Every settings card, by tool name. */
const CARDS: Readonly<Record<string, SettingsToolCard>> = {
  ...coreSettingsToolCards,
  ...personalSettingsToolCards,
  ...adminSettingsToolCards,
};

/** The card for a call by this name, or null when it isn't a settings tool with one. */
export function settingsToolCardFor(name: string): SettingsToolCard | null {
  const tool = settingsToolOf(name);
  return tool ? (CARDS[tool] ?? null) : null;
}

/**
 * One settings call, drawn by its tool's card: what the transcript draws in place of the plain tool
 * line, live as it streams and from history after a reload.
 */
export function SettingsToolCall({
  name,
  args,
  result,
}: {
  name: string;
  args?: string;
  result?: string;
}) {
  const tool = settingsToolOf(name);
  const Card = settingsToolCardFor(name);
  if (!tool || !Card) return null;
  const read = settingsResult(result);
  return (
    <Card
      args={settingsArgs(args)}
      output={read.output}
      state={read.state}
      tool={tool}
      {...(read.reason ? { reason: read.reason } : {})}
    />
  );
}
