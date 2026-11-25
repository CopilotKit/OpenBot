import { outcomeForPerson } from "@openbot/shared/approval-outcomes";
import type { ReactNode } from "react";
import {
  asText,
  refusalOf,
  toolResultFailed,
  withoutOutcomeLine,
  withoutUntrustedEnvelope,
} from "@/lib/plugins/tool-result";
import type { SettingsChange } from "./settings-change-card";

/**
 * The chat cards for OpenBot settings' tools: one purpose-built card per tool, keyed by the tool's
 * name, drawn where the call is in the conversation, live and after a reload.
 *
 * A settings tool is an app tool the server runs, so the model calls it as
 * `mcp__openbot-settings__<tool>` and the transcript draws it by that name. Its result is the tool's
 * structured output as JSON, inside the envelope the server puts around every app answer. A card is
 * handed that output already read, with the call's state, and never parses anything itself.
 *
 * Each slice registers its cards in its own file (`settings-tool-cards-core.tsx`,
 * `settings-tool-cards-personal.tsx`, `settings-tool-cards-admin.tsx`), so nobody edits another's.
 */

/** How the model names a settings tool: the app's key, then the tool's own name. */
export const SETTINGS_TOOL_PREFIX = "mcp__openbot-settings__";

/** Where a call is: under way, answered, refused (by a rule or a person), or broken. */
export type SettingsToolCallState = "running" | "done" | "refused" | "failed";

/** What every settings card is handed. */
export type SettingsToolCardProps<
  Output extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** The tool's own name, e.g. `get_my_settings`. */
  tool: string;
  /** What the Bot called it with. */
  args: Record<string, unknown>;
  /** The tool's structured output, once it answered. Null while running, refused or failed. */
  output: Output | null;
  state: SettingsToolCallState;
  /** Why it was refused or failed, in the person's words. */
  reason?: string;
};

/** A card for one tool. */
export type SettingsToolCard = (props: SettingsToolCardProps) => ReactNode;

/** The cards one slice registers, by tool name. */
export type SettingsToolCards = Readonly<Record<string, SettingsToolCard>>;

/**
 * A tool's own body for its approval card, drawn while the change waits in place of the shared
 * before-and-after rows. `change` is the tool's preview as the server sent it.
 */
export type SettingsApprovalBody = (props: {
  tool: string;
  args: Record<string, unknown>;
  change: SettingsChange;
}) => ReactNode;

/** The approval bodies one slice registers, by tool name. Optional per tool. */
export type SettingsApprovalBodies = Readonly<
  Record<string, SettingsApprovalBody>
>;

/** The settings tool a call is for, or null when it isn't one. */
export function settingsToolOf(name: string): string | null {
  return name.startsWith(SETTINGS_TOOL_PREFIX)
    ? name.slice(SETTINGS_TOOL_PREFIX.length)
    : null;
}

/** A call's arguments as the model wrote them, or nothing when they don't read as an object. */
export function settingsArgs(
  args: string | undefined,
): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A call's result as a card reads it: the state, the output and the reason.
 *
 * The result is what the server wrote for the model: a refusal behind its marker, a failure in its
 * own words, or the tool's JSON inside the untrusted-content envelope with a line in front of it.
 */
export function settingsResult(result: string | undefined): {
  state: SettingsToolCallState;
  output: Record<string, unknown> | null;
  reason?: string;
} {
  if (result === undefined) return { state: "running", output: null };
  const answer = asText(result);
  const refused = refusalOf(answer);
  // In the person's words: the sentence a Bot is told when they said no is written for the model.
  if (refused !== undefined)
    return {
      state: "refused",
      output: null,
      reason: outcomeForPerson(refused),
    };
  if (toolResultFailed(result))
    return {
      state: "failed",
      output: null,
      reason: "This didn't work. Ask your Bot to try again.",
    };
  const inner = withoutUntrustedEnvelope(withoutOutcomeLine(answer)).trim();
  try {
    const parsed: unknown = JSON.parse(inner);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { state: "done", output: parsed as Record<string, unknown> };
  } catch {
    // Not the tool's JSON: drawn as a failure below.
  }
  return {
    state: "failed",
    output: null,
    reason: "This didn't work. Ask your Bot to try again.",
  };
}
