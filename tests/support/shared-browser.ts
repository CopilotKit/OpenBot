const browsers = new Map<string, Promise<unknown>>();

/**
 * One browser for each kind of launch in this process, never closed. For the browser test files.
 *
 * Bun 1.3 closes the pipes of a browser that closed again later, when it collects that child
 * process. By then a browser launched after it can hold the same pipe numbers: its DevTools pipe
 * closes, it exits with code 0, and Playwright does not see it, so each later call waits forever.
 * `bun test a b c` runs the files in one process, so the second browser of a run could die in
 * the middle of its file, and every file after it timed out.
 *
 * A browser that is never closed has no pipes to close again. Its pipe closes when the process
 * exits, and the browser then exits too. `launch` starts the browser the first time for `key`.
 */
export function sharedChromium<B>(
  launch: () => Promise<B>,
  key = "chromium",
): Promise<B> {
  let browser = browsers.get(key) as Promise<B> | undefined;
  if (!browser) {
    browser = launch();
    browsers.set(key, browser);
    // A launch that failed does not stay: the next file tries again.
    browser.catch(() => browsers.delete(key));
  }
  return browser;
}
