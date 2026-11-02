import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import { ownsPersonBrowser } from "../browser/person";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

/**
 * Who may watch, drive or take over a Bot's computer.
 *
 * Whoever may reach it is shown their own seat (computer/computer-key.ts): the Bot on their own
 * computer, or an isolated Bot's computer of its own, which everybody who uses that Bot shares.
 *
 * Seeing a Bot is not enough. A Team Bot reaches teammates through its owner's publication, and a
 * teammate chats with it and it still acts for them through its own governed tools, but only the
 * owner (or an administrator) sees its screen or takes control: an isolated Team Bot's one computer
 * carries the sites its owner signed into, through the password manager or by hand. A public Bot is
 * there for everyone who can sign in, so each of them may work its browser on their own seat.
 */
export function canUseComputer(
  profile: { visibility: string; ownerUserId: string | null } | null,
  actor: Pick<AgentActor, "id" | "role">,
): boolean {
  if (!profile) return false;
  return (
    actor.role === "admin" ||
    profile.visibility === "public" ||
    profile.ownerUserId === actor.id
  );
}

/**
 * The access check the computer routes and the live screen use, read from the profile store.
 *
 * A person's own OpenBot browser is a computer too, named for its person rather than a Bot (browser/person.ts), and only
 * that person reaches it: there is no profile to read, and an administrator who may watch any Bot's screen may not watch
 * a person's own browser.
 */
export function computerAccessCheck(store: Pick<AgentProfileStore, "get">) {
  return async (actor: AgentActor, botId: string) =>
    isPersonBrowserId(botId)
      ? ownsPersonBrowser(actor, botId)
      : canUseComputer(await store.get(actor, botId).catch(() => null), actor);
}
