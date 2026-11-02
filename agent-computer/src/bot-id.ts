/**
 * What a Bot id is allowed to be, before it becomes a path.
 *
 * The id arrives as the `x-openbot-bot-id` header, or as the `bot` query parameter on the stream, and
 * the API server forwards whatever segment a caller put in the URL. It then becomes the directory a
 * Chromium profile lives in, which `reset` deletes with `rm -rf`, as root. So this is the same class
 * of input `workspace.ts` already treats as hostile, and it needs the same answer: an id that is not
 * a plain name never reaches `join`.
 *
 * The rules match `supervisor/src/names.ts`, which has held this line for container and volume names
 * since it was written: letters, digits, hyphen and underscore, starting with a letter or digit. No
 * separators, so a name cannot escape into another path segment. No dots, which Docker permits and
 * which invite `..` reasoning. Deliberately narrower than the filesystem allows, because the set of
 * ids a deployment legitimately uses is narrower still.
 *
 * It lives in its own file rather than in `index.ts` for the reason `authorisation.ts` does: that file
 * imports Playwright at module scope, so anything in it needs Chrome merely to be imported by a test,
 * and a decision this size should be testable without a browser.
 */

/** Long enough for a uuid-shaped agent id, short enough to stay a sane directory name. */
const MAX_BOT_ID = 64;

const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isPlainBotId(value: string): boolean {
  return value.length <= MAX_BOT_ID && ALLOWED.test(value);
}

/** Thrown rather than returned, so a caller cannot use the path by forgetting to check. */
export class UnusableBotIdError extends Error {
  constructor(botId: string) {
    super(
      `A bot id may contain only letters, digits, hyphen and underscore, and must start with a letter or digit: ${JSON.stringify(botId)}`,
    );
    this.name = "UnusableBotIdError";
  }
}

/**
 * A Bot's place on this computer: its browser profile, its folder and its session.
 *
 * WHY THE PERSON IS IN IT. One process can serve many people: Helm's `computers.mode: shared` runs a
 * single computer for the whole deployment. Keyed by the Bot alone there, a public Bot had one
 * profile, so whoever signed it into a site signed it in for everybody. On that computer the server
 * names the person as well (`x-openbot-person-id`), and the seat is the pair, so each person's logins
 * stay their own. A computer the supervisor or the sandbox makes belongs to one person already, and
 * there the server names only the Bot and the seat is the Bot's id, exactly as before.
 *
 * `~` joins the two because it is in neither half: both are held to {@link isPlainBotId}, so the
 * first `~` is where the person ends. It is not a path separator, cannot spell `..`, and a seat with
 * one is still a single directory under the root.
 */
export const SEAT_SEPARATOR = "~";

/** The seat for this Bot, for this person when one is named. Throws on an unusable half. */
export function seatIdFor(botId: string, personId?: string): string {
  if (!isPlainBotId(botId)) throw new UnusableBotIdError(botId);
  if (personId === undefined) return botId;
  if (!isPlainBotId(personId)) throw new UnusableBotIdError(personId);
  return `${personId}${SEAT_SEPARATOR}${botId}`;
}

/** Whether a name is a seat this code could have made: a plain Bot id, or a plain person and Bot. */
export function isUsableSeatId(value: string): boolean {
  const parts = value.split(SEAT_SEPARATOR);
  if (parts.length === 1) return isPlainBotId(value);
  return (
    parts.length === 2 &&
    isPlainBotId(parts[0] ?? "") &&
    isPlainBotId(parts[1] ?? "")
  );
}

/** The Bot and, where there is one, the person a seat belongs to. */
export function seatParts(seatId: string): {
  botId: string;
  personId?: string;
} {
  const at = seatId.indexOf(SEAT_SEPARATOR);
  if (at < 0) return { botId: seatId };
  return { personId: seatId.slice(0, at), botId: seatId.slice(at + 1) };
}

/**
 * Where this seat's browser profile lives.
 *
 * The allow-list is the guarantee: a seat with no separator and no dot cannot address anything but a
 * single directory inside the root. The join stays here rather than at the call site so that there is
 * one place a profile path can be built, and it is the checked one.
 */
export function profileDirectoryFor(root: string, seatId: string): string {
  if (!isUsableSeatId(seatId)) throw new UnusableBotIdError(seatId);
  return `${root}/${seatId}`;
}
