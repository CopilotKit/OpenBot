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
 * Where this Bot's browser profile lives.
 *
 * The allow-list is the guarantee: an id with no separator and no dot cannot address anything but a
 * single directory inside the root. The join stays here rather than at the call site so that there is
 * one place a profile path can be built, and it is the checked one.
 */
export function profileDirectoryFor(root: string, botId: string): string {
  if (!isPlainBotId(botId)) throw new UnusableBotIdError(botId);
  return `${root}/${botId}`;
}
