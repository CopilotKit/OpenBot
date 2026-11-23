import {
  type SettingsApprovalBody,
  type SettingsToolCard,
  settingsArgs,
  settingsResult,
  settingsToolOf,
} from "./registry";
import {
  adminSettingsApprovalBodies,
  adminSettingsToolCards,
} from "./settings-tool-cards-admin";
import { coreSettingsToolCards } from "./settings-tool-cards-core";
import {
  personalSettingsApprovalBodies,
  personalSettingsToolCards,
} from "./settings-tool-cards-personal";

/** Every settings card, by tool name. */
const CARDS: Readonly<Record<string, SettingsToolCard>> = {
  ...coreSettingsToolCards,
  ...personalSettingsToolCards,
  ...adminSettingsToolCards,
};

/** Every tool's own approval body, by tool name. */
const APPROVAL_BODIES: Readonly<Record<string, SettingsApprovalBody>> = {
  ...personalSettingsApprovalBodies,
  ...adminSettingsApprovalBodies,
};

/** The settings app's half of a tool's ref (`openbot-settings/<tool>`). */
const SETTINGS_REF_PREFIX = "openbot-settings/";

/** The card for a call by this name, or null when it isn't a settings tool with one. */
export function settingsToolCardFor(name: string): SettingsToolCard | null {
  const tool = settingsToolOf(name);
  return tool && Object.hasOwn(CARDS, tool) ? (CARDS[tool] ?? null) : null;
}

/**
 * A settings tool's own approval body, by the ref an approval names it by
 * (`openbot-settings/<tool>`), or null where it has none and the shared rows are drawn.
 */
export function settingsApprovalBodyFor(
  toolRef: string,
): { tool: string; Body: SettingsApprovalBody } | null {
  if (!toolRef.startsWith(SETTINGS_REF_PREFIX)) return null;
  const tool = toolRef.slice(SETTINGS_REF_PREFIX.length);
  const Body: SettingsApprovalBody | undefined = Object.hasOwn(
    APPROVAL_BODIES,
    tool,
  )
    ? APPROVAL_BODIES[tool]
    : undefined;
  return Body ? { tool, Body } : null;
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
