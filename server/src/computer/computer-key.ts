/**
 * Whose computer a Bot runs on.
 *
 * WHY. Every layer used to key a computer by the Bot alone, so a public Bot, which includes every
 * built-in one, had one computer and one set of logins that everybody in the deployment shared:
 * whoever signed it into a site signed it in for everyone. A computer now belongs to a person, and
 * every Bot that person uses runs on it, each with its own browser profile and folder inside. So
 * logins belong to the pair (person, Bot), and two people on one public Bot never meet.
 *
 * A Bot whose owner ticked "Isolated" gets a computer of its own instead, keyed by the Bot. That is
 * the old behaviour, kept on request: everyone who uses that Bot shares its computer. It holds only
 * while the owner still has the `isolatedComputers` capability; when an administrator withdraws it,
 * the Bot runs on each person's own computer from its next run rather than stopping. Whether a Bot
 * is isolated is decided once, in agents/isolation.ts (`runsIsolated`); this file only turns that
 * verdict into a computer.
 *
 * Who "the person" is: whoever the computer acts for. The person in the conversation, or, for a
 * background turn (a routine, a hand-off, an approval), the owner of that turn.
 *
 * THE BOTS ON A PERSON'S COMPUTER ARE NOT KEPT FROM EACH OTHER, which is the industry standard for an
 * always-on agent's computer: one per user, shared by every Bot that user runs, with Bots isolating
 * personalities and workspaces rather than compute. A command any of them runs, a public Bot
 * somebody else wrote included, can reach anything on that computer, and the admin Computers screen
 * says so. Logins here stay per Bot inside it (a browser profile each), which is stricter than the
 * standard, where a person's Bots share their browser sessions too. A Bot that must be kept apart is
 * made Isolated.
 */
import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";

/** Which computer: a person's, which carries every Bot they use, or an isolated Bot's own. */
export type ComputerKey =
  | { kind: "person"; personId: string }
  | { kind: "bot"; botId: string };

/**
 * A Bot's place on a computer: the computer it runs on, and the Bot whose profile and folder it uses.
 *
 * Every computer call is made for a seat. The key picks the computer; the Bot picks the browser
 * profile, folder and session inside it.
 */
export type ComputerSeat = {
  botId: string;
  key: ComputerKey;
  /**
   * Whether this seat should be given the Bot's profile from before computers were per person.
   *
   * Only a private Bot on its owner's computer: that profile had exactly one user. A public Bot's
   * had no single owner, so its users sign in again once.
   */
  inheritsProfile?: boolean;
};

/** The key as text: `person:<id>` or `bot:<id>`. What the audit trail and the admin screen carry. */
export function computerKeyText(key: ComputerKey): string {
  return key.kind === "person" ? `person:${key.personId}` : `bot:${key.botId}`;
}

/** The key back from its text, or undefined for anything that is not one. */
export function parseComputerKey(text: unknown): ComputerKey | undefined {
  if (typeof text !== "string") return undefined;
  const at = text.indexOf(":");
  if (at < 0) return undefined;
  const kind = text.slice(0, at);
  const id = text.slice(at + 1);
  if (!id || id.length > 200) return undefined;
  if (kind === "person") return { kind, personId: id };
  if (kind === "bot") return { kind, botId: id };
  return undefined;
}

/**
 * The seat as text, which is what server state about a computer is keyed on.
 *
 * `person:<id>/<bot>` on a person's computer, `bot:<bot>` on an isolated Bot's (which has only the
 * one seat). Snapshots and the frames of opened pages are filed under this, so two people on one
 * public Bot never resolve a ref against, or read a picture of, each other's browser.
 */
export function seatText(seat: Pick<ComputerSeat, "botId" | "key">): string {
  return seat.key.kind === "person"
    ? `${computerKeyText(seat.key)}/${seat.botId}`
    : computerKeyText(seat.key);
}

/** A Bot on a person's computer. */
export function personSeat(personId: string, botId: string): ComputerSeat {
  return { botId, key: { kind: "person", personId } };
}

/** A Bot on its own computer: an isolated Bot. */
export function botSeat(botId: string): ComputerSeat {
  return { botId, key: { kind: "bot", botId } };
}

/** What handing on a Bot's old profile needs to know about it: who owns it, and whether it is private. */
export type BotOwnership = {
  ownerUserId: string | null;
  visibility: string;
};

/**
 * The seat a Bot takes when it acts for this person.
 *
 * `isolated` is the verdict of `runsIsolated` in agents/isolation.ts, which is the one place the
 * Bot's Isolated flag and its owner's "Isolated Bots" switch are combined; this file does not decide
 * isolation a second time.
 */
export function seatOf(
  botId: string,
  personId: string,
  bot: BotOwnership | null,
  isolated: boolean,
): ComputerSeat {
  // A person's own browser runs only on a computer of its own (browser/host.ts), never beside their Bots, where a
  // Bot's shell could read what they signed in to by hand off the disk.
  if (isolated || isPersonBrowserId(botId)) return botSeat(botId);
  return {
    ...personSeat(personId, botId),
    ...(bot?.visibility === "private" && bot.ownerUserId === personId
      ? { inheritsProfile: true }
      : {}),
  };
}

export type ComputerSeatResolverOptions = {
  /**
   * Whether the Bot runs on a computer of its own: `runsIsolated` from agents/isolation.ts. True only
   * for a Bot ticked Isolated whose owner holds the switch right now, so an administrator turning it
   * off moves the Bot onto each person's computer from its next run.
   */
  runsIsolated: (botId: string) => Promise<boolean>;
  /** Who owns the Bot and whether it is private. Null for a Bot with no profile row. */
  bot: (botId: string) => Promise<BotOwnership | null>;
  /**
   * The provider's own answer to whether it can make a computer for one Bot.
   *
   * The supervisor and the sandbox can. The one shared computer cannot, so there every Bot takes a
   * seat on it for the person, whatever the Bot asked for.
   */
  canIsolate: boolean;
};

export type ComputerSeatResolver = {
  /** The seat this Bot takes when it acts for this person. */
  seatFor(botId: string, personId: string): Promise<ComputerSeat>;
};

/**
 * The resolver every caller asks, so the rule lives in one place.
 *
 * Asked once per run for a background turn and once per request for a person's screen, so a
 * revoked capability moves a Bot from its next run, never part way through one.
 */
export function createComputerSeatResolver(
  options: ComputerSeatResolverOptions,
): ComputerSeatResolver {
  return {
    async seatFor(botId, personId) {
      if (isPersonBrowserId(botId)) return botSeat(botId);
      const isolated =
        options.canIsolate && (await options.runsIsolated(botId));
      const bot = isolated ? null : await options.bot(botId);
      return seatOf(botId, personId, bot, isolated);
    },
  };
}

/** Who owns a Bot and whether it is private, read from its profile row. Deleted Bots have none. */
export function botOwnership(database: Database) {
  return async (botId: string): Promise<BotOwnership | null> => {
    const [row] = await database
      .select({
        ownerUserId: agentProfiles.ownerUserId,
        visibility: agentProfiles.visibility,
      })
      .from(agentProfiles)
      .where(
        and(eq(agentProfiles.agentId, botId), isNull(agentProfiles.deletedAt)),
      )
      .limit(1);
    return row ?? null;
  };
}
