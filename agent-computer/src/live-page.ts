// Its own file so a test can reach it without the Playwright import `profiles.ts` carries.

/** Enough of a page for the choice. Keeps this file independent of what else is on one. */
export type OpenPage = { isClosed(): boolean };

// The newest open page wins, so a window the site opens becomes the one being watched and driven,
// and closing it falls back to whatever is still open rather than to a page that has gone.
export function chooseLivePage<T extends OpenPage>(
  opened: readonly T[],
): T | undefined {
  for (let index = opened.length - 1; index >= 0; index -= 1) {
    const page = opened[index];
    if (page && !page.isClosed()) return page;
  }
  return undefined;
}
