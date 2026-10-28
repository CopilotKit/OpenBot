/**
 * Handing a private Bot's old profile to the person it belonged to.
 *
 * WHY. On a computer many people share, a Bot's profile used to be keyed by the Bot alone
 * (`/profiles/<bot>`), so every person using it shared its logins. Seats are now per person and Bot
 * (see `seatIdFor`). For a private Bot that old profile had exactly one user, its owner, so the server
 * asks for it to be moved to the owner's seat and nobody has to sign in again. A public Bot's old
 * profile had no single owner and is never asked for: its users sign in again once.
 *
 * ONCE, BY CONSTRUCTION. A move leaves nothing behind to move a second time, and a seat that already
 * has a profile keeps it: that is a person who has used the Bot since, and their newer logins win.
 *
 * Free of Playwright on purpose, like `profile-listing.ts`, so the rule is testable without a browser.
 */
import { rename, stat } from "node:fs/promises";
import { profileDirectoryFor } from "./bot-id";

/** What happened: moved, kept the seat's own profile, or there was nothing to move. */
export type CarryOverOutcome = "moved" | "kept" | "absent";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Move `/profiles/<botId>` to `/profiles/<seatId>`, once.
 *
 * `closeOld` closes a browser still open on the old profile first, so Chromium flushes it and nothing
 * is writing to the directory while it moves. A rename, so it is atomic on the one volume both live
 * on: a reader sees the old profile or the new one, never half of each.
 */
export async function carryOverProfile(
  root: string,
  botId: string,
  seatId: string,
  closeOld: () => Promise<unknown>,
): Promise<CarryOverOutcome> {
  // A seat that is the Bot itself has nothing to inherit from.
  if (seatId === botId) return "absent";
  const from = profileDirectoryFor(root, botId);
  const to = profileDirectoryFor(root, seatId);
  if (await exists(to)) return "kept";
  if (!(await exists(from))) return "absent";
  await closeOld();
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Gone, or the seat got a profile of its own in between: either way there is nothing to do.
    if (code === "ENOENT") return "absent";
    if (code === "EEXIST" || code === "ENOTEMPTY") return "kept";
    throw error;
  }
  return "moved";
}
