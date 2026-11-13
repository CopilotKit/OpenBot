import { tryClient } from "@/lib/client";
import { desktopShell } from "@/lib/desktop/shell";

/**
 * THE ASK TO STAR OPENBOT ON GITHUB, AND THE MOMENT THAT EARNS IT.
 *
 * A star is how other people find an open-source project, and somebody already getting work done in
 * OpenBot is the person most likely to give one. So OpenBot asks once, at one moment, in a card above
 * the composer (`components/star-prompt/star-prompt.tsx`), and keeps a permanent link in Settings →
 * General. The deployment can turn both off (`OPENBOT_STAR_PROMPT`), and either answer is saved to
 * the person's preferences, so it is asked once on every device they sign in from.
 *
 * WHICH MOMENT IS ONE CONSTANT, ON PURPOSE. There is no experiment framework here, so the moments are
 * compared one release at a time: ship one, read the counts, switch. Each answer is counted with the
 * trigger that asked (docs/TELEMETRY.md, "The star prompt"), which is what lets two releases be
 * compared when the project's own star count also moves with every launch and post.
 *
 * - `prompts`: once five of this person's messages from this browser have been answered. A fresh
 *   install already has Bots to talk to, so this reaches nearly everybody who uses OpenBot. (In a
 *   browser that has not answered the notifications offer, the card waits behind it; see
 *   `conversation-view.tsx`.)
 * - `bot_created`: once they create a Bot from this browser, which fewer people ever do.
 *
 * What earned it is kept in this browser rather than on the account: it is a nudge, not a record, and
 * counting every message on the server would be a write per message for nothing else.
 */
export type StarPromptTrigger = "prompts" | "bot_created";

/** Where an answer came from: the card, under the trigger that showed it, or Settings' link. */
export type StarPromptSource = StarPromptTrigger | "settings";

/** What is counted. The server accepts exactly these (server/src/telemetry/product.ts). */
export type StarPromptEvent =
  | "star_prompt_shown"
  | "star_prompt_clicked"
  | "star_prompt_dismissed";

/** The moment this build asks at. Change it here to compare another one. */
export const STAR_PROMPT_TRIGGER: StarPromptTrigger = "prompts";

/** How many messages earn `prompts`. */
export const STAR_PROMPT_AFTER_PROMPTS = 5;

/** Where Star on GitHub goes. The repository's own page, which has the Star button. */
export const OPENBOT_REPO_URL = "https://github.com/CopilotKit/OpenBot";

/** Messages sent from this browser, counted up to the threshold and no further. */
export const STAR_PROMPT_PROMPTS_KEY = "openbot-star-prompt-prompts";

/** Set once a Bot is created from this browser. */
export const STAR_PROMPT_BOT_CREATED_KEY = "openbot-star-prompt-bot-created";

/** Set once this browser has reported the card shown for a trigger, so it reports it once. */
const shownKey = (trigger: StarPromptTrigger) =>
  `openbot-star-prompt-shown-${trigger}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage refused (a private window, blocked site data): nothing is earned, so nothing is asked.
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to keep it in. The ask simply never comes, which is the quiet way to fail.
  }
}

function promptsSent(): number {
  const count = Number.parseInt(read(STAR_PROMPT_PROMPTS_KEY) ?? "", 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * One message this person sent from a conversation. Called once the conversation's `onSubmit` has
 * resolved: in a conversation, when the turn it started is over; for the first message of a new
 * one, when the conversation is made.
 */
export function notePromptSent(): void {
  const sent = promptsSent();
  // Stops at the threshold: past it, the count changes nothing, so there is nothing to write.
  if (sent >= STAR_PROMPT_AFTER_PROMPTS) return;
  write(STAR_PROMPT_PROMPTS_KEY, String(sent + 1));
}

/** A Bot this person created. Called from the create mutation, so every way of creating one counts. */
export function noteBotCreated(): void {
  write(STAR_PROMPT_BOT_CREATED_KEY, new Date().toISOString());
}

/** Whether this browser has reached the moment `trigger` asks at. */
export function starPromptEarned(
  trigger: StarPromptTrigger = STAR_PROMPT_TRIGGER,
): boolean {
  return trigger === "prompts"
    ? promptsSent() >= STAR_PROMPT_AFTER_PROMPTS
    : read(STAR_PROMPT_BOT_CREATED_KEY) !== null;
}

/**
 * Whether this is the first time this browser draws the card for `trigger`, marking it drawn. The
 * server counts people either way; this keeps a card somebody ignores from sending a show, and a
 * billed event, for every conversation they open. Storage that refuses answers yes every time, which
 * the server still counts once.
 */
export function firstStarPromptShow(trigger: StarPromptTrigger): boolean {
  if (read(shownKey(trigger)) !== null) return false;
  write(shownKey(trigger), new Date().toISOString());
  return true;
}

/**
 * Count a show or an answer. Best effort: the server derives who and where from the session, and a
 * count that does not arrive changes nothing on screen. Never throws, so a caller can fire and forget.
 */
export async function recordStarPrompt(
  kind: StarPromptEvent,
  trigger: StarPromptSource,
): Promise<void> {
  try {
    const response = await tryClient("/api/telemetry/product-events", {
      method: "POST",
      body: {
        kind,
        trigger,
        surface: desktopShell() === null ? "web" : "desktop",
      },
    });
    if (!response.ok)
      console.warn("Star prompt telemetry was not accepted.", response.status);
  } catch {
    console.warn("Star prompt telemetry could not be delivered.");
  }
}
