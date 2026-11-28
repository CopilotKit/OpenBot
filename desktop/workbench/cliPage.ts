// Shared Playwright boundary for the manual screenshot command.
export const PLAYWRIGHT: string = "playwright-core";
export type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(run: () => unknown): Promise<unknown>;
  evaluate<T, A = undefined>(
    run: ((arg: A) => T) | string,
    arg?: A,
  ): Promise<T>;
  locator(selector: string): {
    screenshot(options: { path: string }): Promise<unknown>;
  };
  close(): Promise<void>;
};
export type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    reducedMotion: "reduce";
    locale: string;
    timezoneId: string;
  }): Promise<Page>;
  close(): Promise<void>;
};
export type Chromium = {
  launch(options: { channel: string }): Promise<Browser>;
};
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
}
export function readPageReport(page: Page) {
  return page.evaluate(() => {
    const p = window.__workbenchPage;
    return {
      kind: p?.kind,
      route: p?.route(),
      config: p?.config(),
      elements: p?.elements() ?? [],
      warnings: p?.warnings() ?? [],
      calls: p?.calls() ?? [],
      requests: p?.requests() ?? [],
      errors: p?.errors() ?? [],
    };
  });
}
