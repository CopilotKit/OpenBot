// What the two page-driving CLIs share: `workbench:shot` (shot.ts) and `workbench:critique`
// (critique.ts). The Playwright types they use, the flags they both read, and the steps that drive
// the workbench page: open a scene, seek, wait one frame, read the page's report.
import { resolve } from "node:path";
import {
  APP_SIDEBARS,
  APP_SKINS,
  type ApiRecord,
  type AppHost,
  type Role,
} from "./appContract";
import {
  type AppSettings,
  DEFAULT_APP,
  DEFAULT_WINDOW,
  encodeState,
  type WindowSettings,
  type WorkbenchState,
} from "./urlState";

/** In a variable, so that typecheck does not need Playwright's types. */
export const PLAYWRIGHT: string = "playwright-core";

export type ConsoleMessage = { text(): string };
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
  on(event: "console", listener: (message: ConsoleMessage) => void): void;
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

export const HOSTS: readonly AppHost[] = ["desktop", "browser"];
export const ROLES: readonly Role[] = ["member", "admin", "owner"];

/** Prints the message and ends the CLI with code 2 (a bad command line). */
export function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

export function unknownScene(
  id: string,
  scenes: readonly { id: string }[],
): never {
  fail(
    [`There is no scene "${id}". Scenes:`, ...scenes.map((s) => s.id)].join(
      "\n",
    ),
  );
}

/** The flags both CLIs read. */
export type FrameArgs = {
  scene: string;
  at: number;
  out: string;
  window: WindowSettings;
  app: AppSettings;
};

/** The usage text of the flags that parseFrameArgs reads (after the scene). */
export const FRAME_FLAGS_USAGE =
  "[--at <seconds>] [--size <w>x<h>] [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--role member|admin|owner] [--skin openbot|openduet|opendots|openfuse] [--sidebar open|closed] [--out <dir>]";

/**
 * Reads the scene and the shared flags: --at, --size, --os, --theme, --host, --role, --skin,
 * --sidebar and --out.
 * `own` reads the CLI's own flags: it gets the flag and a way to read its value, and gives false
 * for a flag it does not know. A bad flag or value ends the CLI with `usage`.
 */
export function parseFrameArgs(
  argv: readonly string[],
  usage: string,
  defaultOut: string,
  own: (arg: string, value: () => string) => boolean = () => false,
): FrameArgs {
  const window: WindowSettings = { ...DEFAULT_WINDOW };
  const app: AppSettings = { ...DEFAULT_APP };
  let scene = "";
  let at = 0;
  let out = defaultOut;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(usage);
      i++;
      return v;
    };
    switch (arg) {
      case "--at": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 0) fail(usage);
        at = n;
        break;
      }
      case "--size": {
        const m = /^(\d+)x(\d+)$/.exec(value());
        if (!m) fail(usage);
        window.width = Number(m[1]);
        window.height = Number(m[2]);
        break;
      }
      case "--os": {
        const v = value();
        if (v !== "mac" && v !== "windows") fail(usage);
        window.os = v;
        break;
      }
      case "--theme": {
        const v = value();
        if (v !== "light" && v !== "dark") fail(usage);
        window.theme = v;
        break;
      }
      case "--host": {
        const v = value();
        const host = HOSTS.find((h) => h === v);
        if (!host) fail(usage);
        app.host = host;
        break;
      }
      case "--role": {
        const v = value();
        const role = ROLES.find((r) => r === v);
        if (!role) fail(usage);
        app.role = role;
        break;
      }
      case "--skin": {
        const v = value();
        const skin = APP_SKINS.find((s) => s === v);
        if (!skin) fail(usage);
        app.skin = skin;
        break;
      }
      case "--sidebar": {
        const v = value();
        const sidebar = APP_SIDEBARS.find((s) => s === v);
        if (!sidebar) fail(usage);
        app.sidebar = sidebar;
        break;
      }
      case "--out":
        out = resolve(process.cwd(), value());
        break;
      default:
        if (own(arg, value)) break;
        if (arg.startsWith("--") || scene !== "") fail(usage);
        scene = arg;
    }
  }
  return { scene, at, out, window, app };
}

/** The workbench address state of a scene at a time, with the CLI's window and app settings. */
export function frameState(
  scene: string,
  at: number,
  args: Pick<FrameArgs, "window" | "app">,
): WorkbenchState {
  return {
    scene,
    at,
    answers: {},
    env: {},
    window: args.window,
    app: args.app,
  };
}

/** Opens the workbench page on a scene and waits until the page is ready. */
export async function openScenePage(
  browser: Browser,
  url: string,
  scene: string,
  args: Pick<FrameArgs, "window" | "app">,
  beforeLoad?: (page: Page) => void,
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  beforeLoad?.(page);
  await page.goto(
    `${url}/workbench/?${encodeState(frameState(scene, 0, args))}`,
  );
  await page.waitForFunction(() => window.__workbenchPage?.ready === true);
  return page;
}

/** Seeks the page's run to `at` seconds. Rejects when the run stalls. */
export async function seekTo(page: Page, at: number): Promise<void> {
  await page.evaluate((ms) => window.__workbenchPage?.seek(ms), at * 1000);
}

/** Waits one animation frame of the page, so the screenshot shows what the seek drew. */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
}

/** Reads what the workbench page tells about the frame it shows now. */
export function readPageReport(page: Page) {
  return page.evaluate(() => {
    const p = window.__workbenchPage;
    const handedBack = (
      p as { handedBack?: () => unknown } | undefined
    )?.handedBack?.();
    return {
      kind: p?.kind ?? "desktop",
      handedOver: p?.handedOver() ?? false,
      handedBack: (handedBack ?? null) as string | null,
      elements: p?.elements?.() ?? [],
      warnings: p?.warnings?.() ?? [],
      calls: (p?.calls() ?? []) as unknown[],
      requests: p?.requests?.() ?? ([] as readonly ApiRecord[]),
      errors: p?.errors?.() ?? ([] as readonly string[]),
    };
  });
}

export type PageReport = Awaited<ReturnType<typeof readPageReport>>;

/** The message of a thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
