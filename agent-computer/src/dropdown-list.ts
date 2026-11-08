import type { Locator, Page } from "playwright";

/**
 * A native dropdown's open list, and the Enter that would undo a Bot's choice in it.
 *
 * Clicking a `<select>` opens a list the browser draws outside the page, and it stays open until
 * something closes it. A Bot that clicked the dropdown and then typed its choice (which picks it with
 * Playwright's selectOption) changed the value under the open list, and the list did not follow: it
 * still highlights the option it opened on. Enter on an open list accepts what it highlights, so a
 * Bot that pressed Enter next, to confirm or to send the form, quietly put the dropdown back to
 * "Choose one" and sent the form without it.
 *
 * Escape closes the list and keeps the Bot's choice, whichever way it was made: typed (the list never
 * saw it, so there is nothing to accept) or picked with the arrow keys (the list accepts what was
 * moved to). Measured in the computer's Chromium, headed on Xvfb and headless, Playwright 1.62.1. So
 * an Enter meant for an open list is sent as Escape, and every other key goes as it was sent.
 *
 * `:open` matches a `<select>` while its list is showing (https://developer.mozilla.org/docs/Web/CSS/:open).
 * A browser without it answers "not open", which leaves the key as it was.
 */
export async function keyForOpenList(
  target: Page,
  key: string,
  element?: Locator,
): Promise<string> {
  if (key !== "Enter") return key;
  return (await listOpen(target, element)) ? "Escape" : key;
}

/** How long one frame is given to answer, so a page busy in one frame cannot hold a key press. */
const FRAME_CHECK_MS = 1_000;

/**
 * Whether a dropdown's list is open: on the element named, or, for a key pressed on the page, in any
 * frame. Only one list shows at a time and only on the focused dropdown, so a list open anywhere is
 * the one a page-level key reaches.
 */
async function listOpen(target: Page, element?: Locator): Promise<boolean> {
  if (element) {
    return element
      .evaluate((node) => {
        try {
          return node instanceof HTMLSelectElement && node.matches(":open");
        } catch {
          return false;
        }
      })
      .catch(() => false);
  }
  const frames = await Promise.all(
    target.frames().map((frame) =>
      Promise.race([
        frame
          .evaluate(() => {
            try {
              return document.querySelector("select:open") !== null;
            } catch {
              return false;
            }
          })
          .catch(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), FRAME_CHECK_MS),
        ),
      ]),
    ),
  );
  return frames.some(Boolean);
}
