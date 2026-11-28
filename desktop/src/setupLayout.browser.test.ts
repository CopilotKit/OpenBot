import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { AGENT_ORB_CSS } from "../../shared/agent-orb";
import { BOOKING_CALENDAR_ORIGIN } from "../../shared/openbot-for-business";
import { sharedChromium } from "../../tests/support/shared-browser";

/**
 * The AI step's form holds still while the install behind it comes and goes.
 *
 * Seen on Windows: on "Connect your AI", the back end's download card appeared above the endpoint
 * form while the person typed in it, and went when the download ended. Base URL and Model jumped
 * about 100px each time, a click meant for a field landed on "Advanced compatible endpoint options",
 * and the window grew taller and moved to fit. The install's row is in the setup window's sidebar
 * now (`SetupRail`), at its foot, its height held, and never in the step.
 *
 * The real window (`main.tsx` and `styles.css`), bundled as the app is, in a real Chromium, because
 * where a field lands is the browser's layout to decide. Only the native side is scripted, by the
 * fake in `src/fakeNative/` (`states.ts`), as it answers on a first run: install done, the account
 * passed, the rest of OpenBot setting up behind the step, its download arriving and ending.
 *
 *   OPENBOT_APP_BROWSER=1 bun test src/setupLayout.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/*
 * Playwright comes from the root install, which the real-browser CI job has. The desktop's own
 * jobs install only the desktop's dependencies and typecheck this file, so it names the module
 * by a variable and types only the part of it used here.
 */
const PLAYWRIGHT: string = "playwright-core";
type Box = { x: number; y: number; width: number; height: number } | null;
type Locator = {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(options?: { state?: "hidden" | "visible" }): Promise<void>;
  boundingBox(): Promise<Box>;
  textContent(): Promise<string | null>;
  count(): Promise<number>;
  getByRole(
    role: string,
    options?: { name: string | RegExp; exact?: boolean },
  ): Locator;
};
type Route = {
  request(): { url(): string };
  fulfill(response: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
    body: string;
  }): Promise<void>;
};
type Page = {
  addInitScript(script: string): Promise<void>;
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  getByRole(
    role: string,
    options?: { name: string | RegExp; exact?: boolean },
  ): Locator;
  locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByLabel(text: string, options: { exact: boolean }): Locator;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  mouse: {
    click(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    colorScheme?: "light" | "dark";
    userAgent?: string;
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = {
  launch(options: {
    channel: string;
    ignoreDefaultArgs?: string[];
  }): Promise<Browser>;
};

type Window = { script: string; style: string };

/**
 * `marks.ts` as Vite builds it: each vendored mark in `shared/marks` inlined as a data URI, by the
 * file's name.
 */
function vendoredMarks(): string {
  const folder = new URL("../../shared/marks/", import.meta.url);
  const marks = Object.fromEntries(
    readdirSync(folder)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => [
        file.replace(/\.svg$/, ""),
        `data:image/svg+xml;base64,${readFileSync(new URL(file, folder)).toString("base64")}`,
      ]),
  );
  return `const byId = new Map(Object.entries(${JSON.stringify(marks)}));
export function markFor(id) { return (id && byId.get(id)) ?? null; }`;
}

/**
 * The window as the app builds it, with the native side scripted. `env` is Vite's build-time
 * values; none set is a build without a whitelabel support page or OpenBot Cloud.
 */
async function buildWindow(env: Record<string, string> = {}): Promise<Window> {
  const built = await Bun.build({
    entrypoints: [
      new URL("./fakeNative/browserEntry.ts", import.meta.url).pathname,
    ],
    target: "browser",
    format: "esm",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify(env),
    },
    plugins: [
      {
        name: "scripted-native-side",
        setup(build) {
          build.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({
            path: new URL("./fakeNative/event.ts", import.meta.url).pathname,
          }));
          build.onResolve({ filter: /^@tauri-apps\/api\// }, () => ({
            path: new URL("./fakeNative/core.ts", import.meta.url).pathname,
          }));
          /*
           * Brand marks come from Vite's glob import, which this build has not got. The same files
           * are inlined here instead, so the window draws every mark the app draws. Left out, the
           * clouds OpenBot for Business runs on showed as four empty tiles.
           */
          build.onResolve({ filter: /^\.\/marks$/ }, () => ({
            path: "marks",
            namespace: "scripted",
          }));
          build.onLoad({ filter: /.*/, namespace: "scripted" }, () => ({
            contents: vendoredMarks(),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "build failed");
  const script = await built.outputs
    .find((out) => out.kind === "entry-point")
    ?.text();
  const style = await built.outputs
    .find((out) => out.path.endsWith(".css"))
    ?.text();
  if (!script) throw new Error("the build has no entry point");
  return { script, style: style ?? "" };
}

/** Served as the shell serves the window: its page, its script and its stylesheet. */
async function open(
  page: Page,
  hash = "",
  served: Window = built,
  headers: Record<string, string> = {},
) {
  await page.route("https://openbot.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/main.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: served.script,
      });
    if (path === "/main.css")
      return route.fulfill({ contentType: "text/css", body: served.style });
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        headers,
        body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      });
    return route.fulfill({ status: 404, body: "" });
  });
  // A secure origin, as the shell's own is: the window's calls are named with `crypto.randomUUID`.
  await page.goto(`https://openbot.test/${hash}`);
}

let browser: Browser;
let built: Window;
/** The same window from a build that turns OpenBot Cloud on. */
let cloudBuilt: Window;
let chromium: Chromium;

beforeAll(async () => {
  if (!asked) return;
  built = await buildWindow();
  cloudBuilt = await buildWindow({ VITE_OPENBOT_CLOUD_ENABLED: "true" });
  const playwright = (await import(PLAYWRIGHT)) as {
    chromium: Chromium;
    webkit: { launch(): Promise<Browser> };
  };
  ({ chromium } = playwright);
  // The CI job installs full Chromium without the headless shell. `OPENBOT_APP_ENGINE=webkit` is
  // for a look in the engine the Mac window draws with, on a machine that has it installed.
  // Never closed: the browser test files of a run share it (see sharedChromium).
  browser =
    process.env.OPENBOT_APP_ENGINE === "webkit"
      ? await sharedChromium(() => playwright.webkit.launch(), "webkit")
      : await sharedChromium(() => chromium.launch({ channel: "chromium" }));
  // bun gives a hook 5 s. Two builds and a browser launch can take longer on a busy machine, and
  // a hook that runs out of time skips the file's tests while it still runs.
}, 120_000);

/**
 * The window come to rest: its fonts loaded, every entrance animation ended (the infinite ones,
 * spinners and the download bar, left running), and two frames drawn after.
 *
 * A fixed wait is not enough. The card's `settle` entrance runs 420 ms on an ease that is still a
 * ten-thousandth of a pixel from home at 400 ms, and a box measured on that offset came back
 * 22.000015 px tall: a one-line name read as two lines about one run in three.
 */
async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(
            Number(animation.effect?.getComputedTiming().endTime),
          ),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    for (let frame = 0; frame < 2; frame++)
      await new Promise((drawn) => requestAnimationFrame(drawn));
  });
}

/** Where the form's first field is, and how tall the page is: what the window is sized to. */
async function measure(page: Page) {
  const field = await page
    .getByLabel("Base URL", { exact: true })
    .boundingBox();
  const advanced = await page
    .getByText("Advanced compatible endpoint options")
    .boundingBox();
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  return { field: field?.y, advanced: advanced?.y, height };
}

/*
 * Seen on Windows F: the window opened at 1016x839, grew to 853 when the sign-in card appeared,
 * then jumped 54 px up and to 992 tall on "Connect your AI". The window keeps its size and place
 * now: the page is never taller than it, the window is never asked to grow, and a step taller than
 * the room it has scrolls inside its card.
 */
/**
 * The longest lines the background row is given, as the native side says them, and whether each
 * sends the person to another window. Kept in step with `docker_desktop_update.rs`,
 * `docker_desktop.rs`, `install.rs` and `engine.rs`.
 */
const LONGEST_ROW_LINES: [string, boolean][] = [
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. Windows will ask for your approval.",
    true,
  ],
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. Your Mac will ask for your password.",
    true,
  ],
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. About 25 minutes left.",
    false,
  ],
  [
    "The Podman on this computer is too old for OpenBot, so OpenBot is updating it. Your Mac will ask for your password.",
    true,
  ],
  [
    "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.",
    true,
  ],
  [
    "Docker Desktop hasn't started yet. It may be waiting for you in its own window. Accept its terms or sign in there, and OpenBot carries on by itself.",
    true,
  ],
  [
    "Preparing this computer to run OpenBot. If a window asks to install a Windows feature OpenBot needs, allow it. Windows then asks for your approval and a restart.",
    true,
  ],
];

describe.skipIf(!asked)("the window through a first run", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the window is the sidebar and the page, never outgrown, and a tall step scrolls in the page`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        const fits = () =>
          page.evaluate(() => ({
            page: document.documentElement.scrollHeight,
            window: window.innerHeight,
            asked: (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter((call) => call === "fit_setup_window").length,
            // The app's own shell: the sidebar, then the step as the page beside it.
            shell: [...(document.querySelector("main")?.children ?? [])].map(
              (child) => child.className,
            ),
            // Only the page scrolls, if anything does.
            scrolling: [...document.querySelectorAll("*")]
              .filter(
                (element) =>
                  /auto|scroll/.test(getComputedStyle(element).overflowY) &&
                  element.scrollHeight > element.clientHeight + 1,
              )
              .map((element) => element.className),
          }));
        const check = async () => {
          const now = await fits();
          expect(now.page).toBeLessThanOrEqual(now.window);
          expect(now.asked).toBe(0);
          expect(now.shell[0]).toMatch(/^rail\b/);
          expect(now.shell[1]).toMatch(/^sheet\b/);
          expect(now.shell.length).toBe(2);
          expect(
            now.scrolling.every(
              (name) => /^sheet\b/.test(name) || name === "setup-body",
            ),
          ).toBe(true);
        };
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await check();
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.waitForTimeout(600);
        await check();
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await check();
        // Taller than the room it has at the smaller size: the page scrolls, the window does not.
        const card = await page.evaluate(() => {
          const sheet = document.querySelector(
            "main > .rail + .sheet > .setup-body",
          ) as HTMLElement;
          return { scroll: sheet.scrollHeight, client: sheet.clientHeight };
        });
        if (height < 600) expect(card.scroll).toBeGreaterThan(card.client);
        expect(card.client).toBeLessThanOrEqual(height);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * Seen on Windows F (a 1016x839 window): "Connect your AI" was taller than the window and scrolled
 * in its card. First the "Installing OpenBot in the background" row sat below the fold; then, with
 * only that row pinned, Continue sat under it with a grey sliver showing until the person
 * scrolled. A step's foot is pinned now, its action in view with the step scrolling above it, and
 * the background row is in view in the sidebar's foot.
 */
describe.skipIf(!asked)("a setup step's foot", () => {
  for (const [width, height] of [
    [1016, 839],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, its action and the background row are in view and uncovered on Account, Licence and AI`, async () => {
      const inView = async (_page: Page, box: Box, what: string) => {
        expect({ what, found: box !== null }).toEqual({ what, found: true });
        expect({ what, top: (box?.y ?? -1) >= 0 }).toEqual({ what, top: true });
        expect({
          what,
          bottom: (box?.y ?? 0) + (box?.height ?? 0) <= height,
        }).toEqual({ what, bottom: true });
      };
      const background = async (page: Page) =>
        inView(
          page,
          await page
            .getByRole("listitem", {
              name: "Preparing OpenBot",
            })
            .boundingBox(),
          "the background row",
        );
      /** The button is in view, and what is at its middle is the button: nothing covers it. */
      const pressable = async (page: Page, name: string) => {
        const button = page.getByRole("button", { name, exact: true });
        await inView(page, await button.boundingBox(), name);
        const covered = await page.evaluate((label) => {
          const found = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === label,
          );
          if (!found) return "missing";
          const box = found.getBoundingClientRect();
          const top = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return top && (top === found || found.contains(top))
            ? null
            : (top?.textContent ?? "nothing").slice(0, 60);
        }, name);
        expect({ name, coveredBy: covered }).toEqual({ name, coveredBy: null });
      };
      const account = await browser.newPage({ viewport: { width, height } });
      try {
        await open(account, "#signin");
        await account
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await account
          .getByRole("heading", { name: "Get your free license key" })
          .waitFor();
        await account.waitForTimeout(600);
        await background(account);
      } finally {
        await account.close();
      }
      const licence = await browser.newPage({ viewport: { width, height } });
      try {
        await open(licence, "#licence");
        await licence
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await licence
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
        await licence.waitForTimeout(600);
        await pressable(licence, "Accept");
        await background(licence);
      } finally {
        await licence.close();
      }
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.waitForTimeout(600);
        // Before a choice, and after it, with its form open and the step scrolling above.
        await pressable(page, "Continue");
        await background(page);
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await pressable(page, "Continue");
        await background(page);
      } finally {
        await page.close();
      }
    }, 40_000);
  }
});

/*
 * Seen on Windows F: on "Connect your AI", Continue moved up 14 px and back down with no input. It
 * shared the pinned foot with the background row, which was 118 px as a plain line and 132 px with
 * a download's bar and bytes. The row is in the sidebar's foot now, never in the step, so nothing
 * the step's buttons sit on changes as it does.
 *
 * Seen in the workbench (install-mac, 7 to 9 layout warnings a frame): the row's own name and badge
 * moved up 20 px as its line wrapped, up 20 px more as a download's bar came, and down 60 px as the
 * download ended. The foot sat at the sidebar's bottom and grew upward with what the row said. It
 * holds its height now, the row hung from its top, so the row's name stays where it is.
 */
describe.skipIf(!asked)(
  "the background row in the sidebar's foot as it changes",
  () => {
    for (const [width, height] of [
      [1016, 839],
      [720, 560],
    ] as const) {
      test(`at ${width}x${height}, Accept and Continue never move, nor the row's name, through every state of the row`, async () => {
        const top = async (page: Page, name: string) =>
          (await page.getByRole("button", { name, exact: true }).boundingBox())
            ?.y;
        /** Where the row's name and the foot's top are, and whether its line is whole and in view. */
        const row = (page: Page) =>
          page.evaluate(() => {
            const foot = document.querySelector(
              "main > .rail > .rail-foot",
            ) as HTMLElement | null;
            const name = foot?.querySelector(".step-label");
            const detail = foot?.querySelector(".step .detail") as
              | HTMLElement
              | null
              | undefined;
            const last = foot?.querySelector(".step")?.getBoundingClientRect();
            return {
              foot: foot?.getBoundingClientRect().top,
              name: name?.getBoundingClientRect().top,
              cut: detail
                ? detail.scrollHeight > detail.clientHeight + 1
                : null,
              inView: !!last && last.bottom <= window.innerHeight,
              inPage: document.querySelector("main > .sheet .step-label")
                ?.textContent,
            };
          });
        const emit = (page: Page, payload: Record<string, unknown>) =>
          page.evaluate(
            (sent) =>
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:progress", sent),
            payload,
          );
        /*
         * Minutes into the install, as on F ("Step 3 of 4 · 3m 26s elapsed"): the wider badge is
         * what pushed the row's name onto a second line there.
         */
        const minutesIn = (page: Page) =>
          page.evaluate(() => {
            const real = Date.now;
            Date.now = () => real() + 10 * 60 * 1000;
            // Wider type than this browser sets: on Windows F the row's name or its line took a
            // second line. A little letter spacing does the same here.
            const wider = document.createElement("style");
            wider.textContent = ".rail-foot { letter-spacing: 0.12em; }";
            document.head.append(wider);
          });
        const licence = await browser.newPage({ viewport: { width, height } });
        try {
          await open(licence, "#licence-installing");
          await licence
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await licence
            .getByRole("heading", { name: "Accept the license agreement" })
            .waitFor();
          await minutesIn(licence);
          await licence.waitForTimeout(1200);
          const accept: (number | undefined)[] = [];
          const held: Array<[string, Awaited<ReturnType<typeof row>>]> = [];
          // The longest lines that reach this row, each read whole and in view: an engine update
          // with its prompt (on Windows G cut at "...so OpenBo…"), and Docker Desktop's own window
          // ("...when Docker is…"). The step's button stays where it was.
          for (const [detail, elsewhere] of LONGEST_ROW_LINES) {
            await emit(licence, {
              step: "engine",
              ok: true,
              running: true,
              elsewhere,
              detail,
            });
            await licence
              .locator(".rail-foot .step .detail", { hasText: detail })
              .waitFor();
            const now = await row(licence);
            expect({ detail, cut: now.cut, inView: now.inView }).toEqual({
              detail,
              cut: false,
              inView: true,
            });
            accept.push(await top(licence, "Accept"));
          }
          // A plain line.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Checking what OpenBot needs to download.",
          });
          await licence
            .getByText("Checking what OpenBot needs to download.")
            .waitFor();
          accept.push(await top(licence, "Accept"));
          held.push(["plain", await row(licence)]);
          // Downloading, with its bar and bytes.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading OpenBot.",
            downloads: {
              done: 1,
              total: 5,
              bytes: 300_000_000,
              size: 1_100_000_000,
              bytesPerSecond: 9_000_000,
            },
          });
          await licence
            .getByText("300.0 MB of 1.1 GB", { exact: false })
            .waitFor();
          accept.push(await top(licence, "Accept"));
          held.push(["downloading", await row(licence)]);
          // Unpacking.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading OpenBot.",
            downloads: {
              done: 3,
              total: 5,
              bytes: 1_100_000_000,
              size: 1_100_000_000,
            },
          });
          await licence.getByText(/Unpacking OpenBot/).waitFor();
          accept.push(await top(licence, "Accept"));
          held.push(["unpacking", await row(licence)]);
          // Installed, and the rest waiting for the person.
          await licence.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishInstall: () => void } }
            ).__fake.finishInstall(),
          );
          await licence.getByText(/Waiting for you/).waitFor();
          accept.push(await top(licence, "Accept"));
          held.push(["waiting", await row(licence)]);
          expect(accept.every((y) => y !== undefined && y === accept[0])).toBe(
            true,
          );
          // Never in the step, and its name and the foot's top where they were in every usual form.
          const first = held[0]?.[1];
          expect(first?.name).toBeGreaterThan(0);
          expect(
            held.map(([state, at]) => [state, at.inPage, at.foot, at.name]),
          ).toEqual(
            held.map(([state]) => [state, undefined, first?.foot, first?.name]),
          );
        } finally {
          await licence.close();
        }

        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page);
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          await minutesIn(page);
          await page.waitForTimeout(1200);
          const seen: Array<[string, number | undefined, number | undefined]> =
            [];
          const look = async (state: string) =>
            seen.push([
              state,
              await top(page, "Continue"),
              (await row(page)).name,
            ]);
          // A plain line: setting up, with nothing downloading.
          await page.getByText(/Setting up OpenBot on this computer/).waitFor();
          await look("plain");
          // Downloading the rest, with its bar and bytes.
          await page.evaluate(() => {
            (
              globalThis as unknown as { __fake: { download: unknown } }
            ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
          });
          await page.getByText("400.0 MB of 1.6 GB").waitFor();
          await look("downloading");
          // Installed.
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishSetUp: () => void } }
            ).__fake.finishSetUp(),
          );
          await page.getByText("OpenBot is installed").waitFor();
          await look("installed");
          const [, continueAt, nameAt] = seen[0] ?? [];
          expect(continueAt).toBeGreaterThan(0);
          expect(nameAt).toBeGreaterThan(0);
          expect(seen).toEqual(
            seen.map(([state]) => [state, continueAt, nameAt]),
          );
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  },
);

/*
 * Seen on the Account step while the person signs in: the background row sat flush against Cancel
 * with no gap at all, and on every step it was a second spinner beside the step's own. The row is
 * in the sidebar's foot now, on every step that has it, and never in the step: the page holds the
 * step and nothing else, and the row is in view without a scroll.
 */
describe.skipIf(!asked)("the background row on every step", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, is in the sidebar's foot and never in the page, beside Cancel, Accept and Continue`, async () => {
      const where = (page: Page) =>
        page.evaluate(() => {
          const named = (root: Element | null) =>
            [...(root?.querySelectorAll(".step") ?? [])].filter(
              (step) => step.getAttribute("aria-label") === "Preparing OpenBot",
            );
          const rail = document.querySelector("main > .rail");
          const sheet = document.querySelector("main > .rail + .sheet");
          const row = named(
            rail?.querySelector(":scope > .rail-foot") ?? null,
          )[0];
          const box = row?.getBoundingClientRect();
          return {
            shell: !!rail && !!sheet,
            inFoot: !!row,
            inPage:
              named(sheet).length +
              (sheet?.querySelectorAll(".behind-slot").length ?? 0),
            inView: !!box && box.top >= 0 && box.bottom <= window.innerHeight,
            // It never spins: the step's own wait is the one that does.
            spins: !!row?.querySelector(".step-spinner"),
          };
        });
      const scenes: Array<[string, string, string]> = [
        ["#signin", "Get your free license key", "Cancel"],
        ["#licence", "Accept the license agreement", "Accept"],
        ["", "Connect your AI", "Continue"],
      ];
      for (const [hash, heading, button] of scenes) {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page, hash);
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page.getByRole("heading", { name: heading }).waitFor();
          await page
            .getByRole("button", { name: button, exact: true })
            .waitFor();
          await settled(page);
          expect({ heading, ...(await where(page)) }).toEqual({
            heading,
            shell: true,
            inFoot: true,
            inPage: 0,
            inView: true,
            spins: false,
          });
        } finally {
          await page.close();
        }
      }
    }, 40_000);
  }
});

/*
 * Seen on Windows F: on the first screen the download line shrank about 40px when the download
 * finished ("Downloading OpenBot." with its bar and bytes, then a line saying it was downloaded),
 * and the text under it moved up. The line holds its tallest height in every state, and before it
 * says anything, so the card's bottom edge stays where it is.
 */
describe.skipIf(!asked)("the first screen at the window's default size", () => {
  // The window opens at 1000x800 (tauri.conf.json); a title bar takes some of that. Seen on
  // Windows: once the first screen listed where OpenBot runs and what this computer needs, the card
  // showed a scrollbar for a few pixels at that size. Everything on it has to show without one.
  for (const theme of ["light", "dark"] as const) {
    test(`at 1000x760 (${theme}), everything on it shows without a scroll, OpenBot for Business's two ways stacked`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
        colorScheme: theme,
      });
      const shots = process.env.OPENBOT_APP_SHOTS;
      try {
        await open(page);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await page.waitForTimeout(400);
        // A build without OpenBot Cloud (VITE_OPENBOT_CLOUD_ENABLED unset) offers no Cloud row.
        expect(await page.getByText("OpenBot Cloud").count()).toBe(0);
        if (shots)
          await page.screenshot({ path: `${shots}/welcome-off-${theme}.png` });
        const shape = await page.evaluate(() => {
          const card = document.querySelector(
            "main > .rail + .sheet",
          ) as HTMLElement;
          const rail = document.querySelector("main > .rail") as HTMLElement;
          const group = document.querySelector(".tile-group") as HTMLElement;
          const [cloud, own] = [
            ...document.querySelectorAll(".tile-option"),
          ].map((option) => option.getBoundingClientRect());
          const marks = [...document.querySelectorAll(".cloud-mark")].map(
            (mark) => mark.getBoundingClientRect(),
          );
          const box = group.getBoundingClientRect();
          return {
            // Neither the page nor the sidebar scrolls.
            overflow: Math.max(
              card.scrollHeight - card.clientHeight,
              rail.scrollHeight - rail.clientHeight,
              document.documentElement.scrollHeight - window.innerHeight,
            ),
            // One above the other, the same width, inside the Business row.
            stacked:
              !!cloud &&
              !!own &&
              own.top >= cloud.bottom &&
              cloud.width === own.width &&
              own.right <= box.right &&
              own.bottom <= box.bottom,
            // The four clouds' marks on Self-Hosted's own line, inside its row.
            marks:
              marks.length === 4 &&
              !!own &&
              marks.every(
                (mark) =>
                  mark.top >= own.top &&
                  mark.bottom <= own.bottom &&
                  mark.right <= own.right &&
                  mark.top === marks[0]?.top,
              ),
            // The artifact's descriptions and real radio controls are visible.
            descriptions: [
              ...document.querySelectorAll(".tile-option-summary"),
            ].every((text) => text.getBoundingClientRect().height > 0),
            radios: [
              ...document.querySelectorAll<HTMLElement>(".hosting .tile-input"),
            ].every(
              (input) =>
                getComputedStyle(input).opacity === "1" &&
                input.getBoundingClientRect().width > 0 &&
                input.getBoundingClientRect().height > 0,
            ),
          };
        });
        const { overflow, ...laid } = shape;
        expect(overflow).toBeLessThanOrEqual(0);
        expect(laid).toEqual({
          stacked: true,
          marks: true,
          descriptions: true,
          radios: true,
        });
        // And connecting to a company's own OpenBot, by the link under the rows: the address and Connect.
        await page.getByRole("button", { name: "Connect to it" }).click();
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .waitFor();
        await page.waitForTimeout(400);
        expect(
          await page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            return card.scrollHeight - card.clientHeight;
          }),
        ).toBeLessThanOrEqual(0);
        expect(
          await page.getByRole("button", { name: "Connect" }).count(),
        ).toBe(1);
      } finally {
        await page.close();
      }
    });

    /*
     * A build with OpenBot Cloud on: OpenBot Cloud and OpenBot for Business as the sidebar's two
     * rows, Cloud picked with its sign-in in the page, and OpenBot (Self-Contained) a line in the
     * sidebar's foot. All of it fits, and so does Self-Contained opened, with Install, and the
     * address.
     */
    test(`at 1000x760 (${theme}), a build with OpenBot Cloud on offers all three hosting choices and keeps the selected page in view`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
        colorScheme: theme,
      });
      const shots = process.env.OPENBOT_APP_SHOTS;
      try {
        await routeCalendar(page);
        await open(page, "", cloudBuilt);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await page
          .getByRole("button", { name: "Sign in to OpenBot Cloud" })
          .waitFor();
        // Measured in the window's own face, at rest: a line set in the fallback, before Inter has
        // loaded, can wrap where Inter's doesn't, and the card's entrance moves every box.
        await settled(page);
        const shape = await page.evaluate(() => {
          const rail = document.querySelector("main > .rail") as HTMLElement;
          const sheet = document.querySelector(
            "main > .rail + .sheet",
          ) as HTMLElement;
          const rows = [
            ...rail.querySelectorAll("fieldset.picker.hosting > .tile"),
          ];
          const boxes = rows.map((row) => row.getBoundingClientRect());
          const business = rail.querySelector(
            ".tile.with-marks",
          ) as HTMLElement;
          const box = business.getBoundingClientRect();
          const marks = [...business.querySelectorAll(".cloud-mark")].map(
            (mark) => mark.getBoundingClientRect(),
          );
          return {
            // Neither the page nor the sidebar scrolls.
            overflow: Math.max(
              sheet.scrollHeight - sheet.clientHeight,
              rail.scrollHeight - rail.clientHeight,
              document.documentElement.scrollHeight - window.innerHeight,
            ),
            // Each cloud's own mark, drawn: an empty tile is a mark that didn't load.
            drawn: [
              ...business.querySelectorAll<HTMLImageElement>(".cloud-mark img"),
            ].map((image) => [
              image.dataset.mark,
              image.complete && image.naturalWidth > 0,
            ]),
            // Cloud and Business, in that order, one above the other in the sidebar, the same
            // width, Cloud picked.
            rows: rows.map(
              (row) => row.querySelector(".tile-name")?.textContent ?? "",
            ),
            stacked: boxes.every(
              (row, at) =>
                row.width === boxes[0]?.width &&
                (at === 0 || row.top >= (boxes[at - 1]?.bottom ?? 0)),
            ),
            picked: rail.querySelector(".tile.chosen .tile-name")?.textContent,
            // Cloud's sign-in is the page, under its own name.
            page: sheet.querySelector(".choice-head h2")?.textContent,
            signIn: [...sheet.querySelectorAll("button")].some(
              (button) => button.textContent === "Sign in to OpenBot Cloud",
            ),
            localChoice:
              rows[2]?.querySelector<HTMLInputElement>("input")?.value ===
              "this-computer",
            // The four clouds' marks inside OpenBot for Business's row, on one line.
            marks:
              marks.length === 4 &&
              marks.every(
                (mark) =>
                  mark.top >= box.top &&
                  mark.bottom <= box.bottom &&
                  mark.right <= box.right &&
                  mark.top === marks[0]?.top,
              ),
            // No row's name or line is cut.
            whole: [
              ...rail.querySelectorAll(
                "fieldset.picker.hosting .tile-name, fieldset.picker.hosting .tile-summary",
              ),
            ].every((text) => text.scrollWidth <= text.clientWidth),
          };
        });
        const { overflow, ...laid } = shape;
        expect(overflow).toBeLessThanOrEqual(0);
        expect(laid).toEqual({
          drawn: [
            ["aws", true],
            ["azure", true],
            ["google-cloud", true],
            ["kubernetes", true],
          ],
          rows: [
            "OpenBot Cloud",
            "OpenBot for Business",
            "OpenBot (Self-Contained)",
          ],
          stacked: true,
          picked: "OpenBot Cloud",
          page: "OpenBot Cloud",
          signIn: true,
          localChoice: true,
          marks: true,
          whole: true,
        });
        if (shots) {
          await page.screenshot({ path: `${shots}/welcome-on-${theme}.png` });
        }
        /*
         * OpenBot for Business picked: its page, the way it runs, Book a demo and what it adds, all
         * of it inside the page with no scrollbar. Book a demo opens the booking step, its heading
         * at the top and focused, and the calendar held to the room left, still with no scrollbar.
         */
        await page.getByText("Your own cloud or on-prem. Book a demo.").click();
        await page
          .getByRole("button", { name: "Book a demo", exact: true })
          .waitFor();
        await page.waitForTimeout(200);
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-business-${theme}.png`,
          });
        const business = await page.evaluate(() => {
          const card = document.querySelector("main > .sheet") as HTMLElement;
          const view = card.getBoundingClientRect();
          const book = [...card.querySelectorAll("button")]
            .find((button) => button.textContent === "Book a demo")
            ?.getBoundingClientRect();
          const more = card
            .querySelector(".business-all")
            ?.getBoundingClientRect();
          return {
            overflow: card.scrollHeight - card.clientHeight <= 0,
            book: !!book && book.bottom <= view.bottom,
            more: !!more && more.bottom <= view.bottom,
            marks: card.querySelectorAll(".cloud-mark").length,
            calendar: !!card.querySelector('iframe[title="Booking calendar"]'),
          };
        });
        // Wider artifact radio rows leave a narrower detail column. Features may scroll;
        // the primary booking action stays visible and all feature copy remains present.
        expect(business.book).toBe(true);
        expect(business.marks).toBe(4);
        expect(business.calendar).toBe(false);
        expect(
          await page.getByText("And tons more…", { exact: true }).count(),
        ).toBe(1);
        await page
          .getByRole("button", { name: "Book a demo", exact: true })
          .click();
        await page
          .locator(
            '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
          )
          .waitFor();
        await page.waitForTimeout(200);
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-business-booker-${theme}.png`,
          });
        const booker = await page.evaluate(() => {
          const card = document.querySelector(
            "main > .rail + .sheet",
          ) as HTMLElement;
          const rail = document.querySelector("main > .rail") as HTMLElement;
          const view = card.getBoundingClientRect();
          const frame = document
            .querySelector('iframe[title="Booking calendar"]')
            ?.getBoundingClientRect();
          const heading = document
            .querySelector("#book-a-demo-title")
            ?.getBoundingClientRect();
          return {
            page: document.documentElement.scrollHeight <= window.innerHeight,
            overflow: card.scrollHeight - card.clientHeight <= 0,
            sideways: card.scrollWidth - card.clientWidth <= 0,
            focused: document.activeElement?.id === "book-a-demo-title",
            heading: !!heading && heading.top >= view.top,
            // The calendar fills its reserved surface below the heading.
            calendar:
              !!frame &&
              !!heading &&
              frame.top >= heading.bottom &&
              frame.bottom <= view.bottom &&
              frame.height > 400,
            features: !!document.querySelector(".business-features"),
            // The sidebar never scrolls: only the page does, when anything does.
            railScrolls: rail.scrollHeight > rail.clientHeight + 1,
          };
        });
        expect(booker).toEqual({
          page: true,
          overflow: true,
          sideways: true,
          focused: true,
          heading: true,
          calendar: true,
          features: false,
          railScrolls: false,
        });
        // Back: the features again.
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.locator(".business-features").waitFor();
        expect(
          await page.locator('iframe[title="Booking calendar"]').count(),
        ).toBe(0);
        // Self-Contained opened at the foot: what this computer needs and Install, still without a
        // scrollbar.
        await page
          .getByRole("radio", { name: /^OpenBot \(Self-Contained\)/ })
          .click();
        await page
          .getByRole("button", { name: "Install", exact: true })
          .waitFor();
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            return card.scrollHeight - card.clientHeight;
          }),
        ).toBeLessThanOrEqual(0);
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-self-contained-${theme}.png`,
          });
        // Connect to it: the address and Connect, still without a scrollbar.
        await page.getByRole("button", { name: "Connect to it" }).click();
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .waitFor();
        // The pointer off the card, as a person's is once they type: nothing shows hovered.
        await page.mouse.move(2, 2);
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            return {
              overflow: card.scrollHeight - card.clientHeight <= 0,
              // Nothing looks picked: no row, and no shaded Self-Contained.
              chosen: document.querySelectorAll(".chosen").length,
            };
          }),
        ).toEqual({ overflow: true, chosen: 0 });
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-connect-${theme}.png`,
          });
      } finally {
        await page.close();
      }
    });
  }

  /*
   * OpenBot for Business books a call: either of its two ways to run, picked, is its own page, what
   * that way means, Book a demo and what it adds, where it used to show an address field. All of it
   * fits the window at 1000x760, the default size less a title bar, and the booking step does too:
   * the calendar fills a reserved surface below its heading. At the
   * window's least size, 720x560, the body may scroll while Back remains in its footer.
   */
  for (const [width, height] of [
    [1000, 760],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, OpenBot for Business shows each way's page and books a demo as its own step, and no address field`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      const roomy = width === 1000;
      try {
        await routeCalendar(page);
        await open(page);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        const pick = async (way: "own-cloud" | "cloud") => {
          await page
            .locator(`label:has(input[value="business-${way}"])`)
            .click();
          await page.locator(".tile-option.chosen").waitFor();
          await settled(page);
        };
        const shape = () =>
          page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            const view = card.getBoundingClientRect();
            const book = [...card.querySelectorAll("button")]
              .find((button) => button.textContent === "Book a demo")
              ?.getBoundingClientRect();
            const wider = [...card.querySelectorAll("*")].filter(
              (element) =>
                element.getBoundingClientRect().right > view.right + 0.5,
            );
            return {
              page: document.documentElement.scrollHeight <= window.innerHeight,
              cardScrolls: card.scrollHeight > card.clientHeight + 1,
              sideways: card.scrollWidth - card.clientWidth,
              wider: wider.map((element) => element.className),
              book: !!book && book.bottom <= view.bottom,
              marks: card.querySelectorAll(".cloud-mark").length,
              way: card.querySelector("#business-way")?.textContent,
              rows: card.querySelectorAll(".business-row").length,
              // From the rows' top hairline to the full list's last line, and whether that is in view.
              ...(() => {
                const rows = card
                  .querySelector(".business-features")
                  ?.getBoundingClientRect();
                const all = card
                  .querySelector(".business-all")
                  ?.getBoundingClientRect();
                return {
                  features: rows && all ? Math.round(all.bottom - rows.top) : 0,
                  inView: !!all && all.bottom <= view.bottom,
                };
              })(),
            };
          });
        await pick("own-cloud");
        const selfHosted = await shape();
        await pick("cloud");
        const cloud = await shape();
        for (const [seen, way, marks] of [
          [
            selfHosted,
            "Run it in your own VPC on AWS, Azure or GCP, or on-prem.",
            4,
          ],
          [cloud, "We run OpenBot for you on OpenBot Cloud.", 0],
        ] as const) {
          expect(seen.page).toBe(true);
          if (!roomy) expect(seen.cardScrolls).toBe(true);
          expect(seen.sideways).toBeLessThanOrEqual(0);
          expect(seen.wider).toEqual([]);
          expect(seen.book).toBe(true);
          expect(seen.way).toBe(way);
          expect(seen.marks).toBe(marks);
          expect(seen.rows).toBe(3);
        }
        // The artifact's wider radio column gives the feature copy a narrower, scrollable pane.
        // Its primary action remains immediately reachable, and the last feature stays reachable.
        await page.evaluate(() =>
          document
            .querySelector(".business-all")
            ?.lastElementChild?.scrollIntoView({ block: "nearest" }),
        );
        expect(
          await page.evaluate(() => {
            const last = document
              .querySelector(".business-all")
              ?.lastElementChild?.getBoundingClientRect();
            const card = document
              .querySelector("main > .sheet")!
              .getBoundingClientRect();
            return !!last && last.top >= card.top && last.bottom <= card.bottom;
          }),
        ).toBe(true);
        expect(
          await page
            .getByLabel("Your company's OpenBot address", { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await page
            .getByRole("button", { name: "Connect", exact: true })
            .count(),
        ).toBe(0);
        expect(
          await page.getByText("A full audit trail, with export").count(),
        ).toBe(1);
        expect(
          await page.locator('iframe[title="Booking calendar"]').count(),
        ).toBe(0);
        // The booking step.
        await page
          .getByRole("button", { name: "Book a demo", exact: true })
          .click();
        await page
          .locator(
            '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
          )
          .waitFor();
        await settled(page);
        const booking = await page.evaluate(() => {
          const card = document.querySelector("main > .sheet") as HTMLElement;
          const frame = document.querySelector(
            'iframe[title="Booking calendar"]',
          ) as HTMLElement;
          return {
            page: document.documentElement.scrollHeight <= window.innerHeight,
            cardScrolls: card.scrollHeight > card.clientHeight + 1,
            sideways: card.scrollWidth - card.clientWidth,
            frame: frame.getBoundingClientRect().height,
            focused: document.activeElement?.id === "book-a-demo-title",
          };
        });
        expect(booking.page).toBe(true);
        expect(booking.sideways).toBeLessThanOrEqual(0);
        expect(booking.focused).toBe(true);
        // The full reported frame is scaled into the remaining height; no outer scroll.
        expect(booking.cardScrolls).toBe(false);
        expect(booking.frame).toBeGreaterThan(roomy ? 400 : 220);
        expect(booking.frame).toBeLessThan(height);
        // Back to the features, and the way to connect is still under the rows.
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.locator(".business-features").waitFor();
        await page.getByRole("button", { name: "Connect to it" }).click();
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .waitFor();
        expect(
          await page.locator('iframe[title="Booking calendar"]').count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    });
  }
});

/**
 * Calendly, as far as the window can tell: a page in the calendar's frame that says its height, as
 * Calendly's inline embed does once it is drawn. The real one is on the web, which a test never is.
 */
async function routeCalendar(page: Page, automatic = true) {
  await page.route("https://calendly.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="margin:0;height:660px;background:#fff;font:14px sans-serif;color:#555;display:grid;place-items:center">Booking calendar (stand-in for Calendly)<script>
        window.addEventListener("message", (message) => {
          if (message.source === parent && message.data?.testCalendar)
            { parent.postMessage(message.data.testCalendar, "*"); parent.postMessage({testCalendarAck: true}, "*"); }
        });
        ${automatic ? 'parent.postMessage({ event: "calendly.page_height", payload: { height: "660px" } }, "*");' : ""}
      </script></body>`,
    }),
  );
}

describe.skipIf(!asked)("approved layout: Cloud hosting narrow", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`720x560 ${colorScheme}: all three choices, local install, connect and calendar stay reachable`, async () => {
      const page = await browser.newPage({
        viewport: { width: 720, height: 560 },
        colorScheme,
      });
      const check = async (selector: string) => {
        const seen = await page.evaluate((selector) => {
          const action = document.querySelector<HTMLElement>(selector)!;
          action.scrollIntoView({ block: "nearest" });
          action.focus();
          const r = action.getBoundingClientRect(),
            hit = document.elementFromPoint(
              r.x + r.width / 2,
              r.y + r.height / 2,
            );
          const rail = document.querySelector<HTMLElement>("main > .rail")!;
          return {
            page: document.documentElement.scrollHeight <= innerHeight,
            sideways: document.documentElement.scrollWidth <= innerWidth,
            rail: rail.scrollHeight <= rail.clientHeight + 1,
            action: r.top >= 0 && r.bottom <= innerHeight,
            hit: !!hit && action.contains(hit),
          };
        }, selector);
        expect(seen).toEqual({
          page: true,
          sideways: true,
          rail: true,
          action: true,
          hit: true,
        });
      };
      try {
        await routeCalendar(page);
        // Settling the startup animation does not mean the saved connection has answered.
        // Hold it until that state is drawn, as on a busy native shell.
        await page.addInitScript(`
          let control;
          Object.defineProperty(globalThis, "__workbench", {
            configurable: true,
            get: () => control,
            set: (next) => {
              control = next;
              next.setAnswer("connection", { mode: "never" });
            },
          });
        `);
        await open(page, "", cloudBuilt);
        await page
          .getByText("Checking your saved setup…", { exact: true })
          .waitFor();
        await settled(page);
        expect(await page.locator(".hosting input").count()).toBe(0);
        await page.evaluate(() =>
          globalThis.__workbench!.setAnswer("connection", {
            mode: "value",
            value: null,
          }),
        );
        await page
          .getByRole("heading", { name: "Set up OpenBot", exact: true })
          .waitFor();
        await page.getByRole("radio", { name: /^OpenBot Cloud/ }).waitFor();
        await settled(page);
        expect(
          await page.evaluate(() =>
            [
              ...document.querySelectorAll<HTMLInputElement>(".hosting input"),
            ].map((x) => x.value),
          ),
        ).toEqual(["cloud", "business", "this-computer"]);
        await check(".cloud-sign-in button");
        await page
          .getByRole("radio", { name: /^OpenBot \(Self-Contained\)/ })
          .click();
        await check(".welcome .row button");
        await page.getByRole("button", { name: "Connect to it" }).click();
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .waitFor();
        await check(".connect-to-openbot input");
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page
          .getByRole("radio", { name: /^OpenBot for Business/ })
          .click();
        await page
          .getByRole("button", { name: "Book a demo", exact: true })
          .click();
        await page.locator('iframe[title="Booking calendar"]').waitFor();
        await check(".booking-back");
        expect(
          await page.evaluate(() => {
            const frame = document
              .querySelector<HTMLIFrameElement>(
                'iframe[title="Booking calendar"]',
              )!
              .getBoundingClientRect();
            return (
              frame.top >= 0 &&
              frame.bottom <= innerHeight &&
              frame.height > 180
            );
          }),
        ).toBe(true);
      } finally {
        await page.close();
      }
    }, 30000);
});

describe.skipIf(!asked)("the first screen while its downloads run", () => {
  const platforms = [
    {
      platform: "macos",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    },
    { platform: "linux", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
  ];
  const sizes = [
    [1000, 800],
    [1000, 760],
    [720, 560],
  ] as const;
  const windows = sizes.flatMap(([width, height]) =>
    platforms.map((platform) => ({ width, height, ...platform })),
  );
  for (const { width, height, platform, userAgent } of windows) {
    for (const colorScheme of ["light", "dark"] as const)
      test(`at ${width}x${height}, downloads stay in the sidebar foot and Install holds its place (${platform}, ${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
          userAgent,
        });
        try {
          await open(page);
          await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
          await page.waitForTimeout(400);
          // The card's bottom edge: nothing under the line moves, and the card does not shrink.
          const usage = async () => {
            return page.evaluate(() => {
              const sheet = document.querySelector(
                "main > .rail + .sheet",
              ) as HTMLElement;
              const foot = document.querySelector(".rail-foot") as HTMLElement;
              const download = foot.querySelector(
                ".early-downloads",
              ) as HTMLElement;
              const button = [...sheet.querySelectorAll("button")].find(
                (button) => button.textContent === "Install",
              );
              const children = [...foot.children].filter(
                (child) => child.getBoundingClientRect().height > 0,
              );
              const boxes = children.map((child) =>
                child.getBoundingClientRect(),
              );
              return {
                sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
                installTop: Math.round(
                  button?.getBoundingClientRect().top ?? -1,
                ),
                inFoot: Boolean(download),
                inSheet: Boolean(sheet.querySelector(".early-downloads")),
                overlap: boxes.some(
                  (box, index) =>
                    index > 0 && box.top < boxes[index - 1]!.bottom - 1,
                ),
                cut: download.scrollWidth > download.clientWidth,
                footBottom: foot.getBoundingClientRect().bottom,
                pageHeight: document.documentElement.scrollHeight,
              };
            });
          };
          const say = async (payload: Record<string, unknown>) => {
            await page.evaluate((sent) => {
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:downloads", sent);
            }, payload);
            await page.waitForTimeout(300);
          };
          const GB = 1_000_000_000;
          const seen: Array<[string, Awaited<ReturnType<typeof usage>>]> = [
            ["nothing yet", await usage()],
          ];
          for (const [state, payload] of [
            ["starting", { state: "downloading", bytes: 0 }],
            [
              "downloading",
              {
                state: "downloading",
                bytes: 0.15 * GB,
                size: 0.31 * GB,
                bytesPerSecond: 9_000_000,
              },
            ],
            ["done", { state: "done", bytes: 0.31 * GB, size: 0.31 * GB }],
            ["failed", { state: "failed", bytes: 0.2 * GB, size: 0.31 * GB }],
            [
              "short of disk",
              {
                state: "short",
                bytes: 0,
                free: 14.6 * GB,
                needed: 44.3 * GB,
                moveTo: "F:",
              },
            ],
          ] as const) {
            await say(payload);
            seen.push([state, await usage()]);
            if (state === "downloading" && process.env.OPENBOT_APP_SHOTS)
              await page.screenshot({
                path: `${process.env.OPENBOT_APP_SHOTS}/welcome-download-${width}x${height}-${platform}-${colorScheme}.png`,
              });
          }
          const first = seen[0]?.[1];
          expect(first?.installTop).toBeGreaterThan(0);
          for (const [state, current] of seen) {
            expect(current.sheetBottom).toBe(first?.sheetBottom);
            expect(current.installTop).toBe(first?.installTop);
            expect(current.inFoot).toBe(true);
            expect(current.inSheet).toBe(false);
            expect(current.overlap).toBe(false);
            expect(current.cut).toBe(false);
            // A short disk adds its move action and warning; the sidebar scrolls to read them.
            if (state !== "short of disk")
              expect(current.footBottom).toBeLessThanOrEqual(height);
            expect(current.pageHeight).toBeLessThanOrEqual(height);
          }
          const move = page.getByRole("button", {
            name: "Move OpenBot's storage to F:",
          });
          await page.evaluate(() => {
            const button = [
              ...document.querySelectorAll(".rail-foot button"),
            ].find((button) =>
              button.textContent?.includes("Move OpenBot's storage"),
            );
            button?.scrollIntoView({ block: "center" });
          });
          const moveBox = await move.boundingBox();
          expect(moveBox).not.toBeNull();
          if (moveBox) {
            expect(moveBox.x).toBeGreaterThanOrEqual(0);
            expect(moveBox.y).toBeGreaterThanOrEqual(0);
            expect(moveBox.y + moveBox.height).toBeLessThanOrEqual(height);
            const railBox = await page.locator("main > .rail").boundingBox();
            expect(moveBox.x + moveBox.width).toBeLessThanOrEqual(
              (railBox?.x ?? 0) + (railBox?.width ?? 0),
            );
          }
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/welcome-move-${width}x${height}-${platform}-${colorScheme}.png`,
            });
          await move.click();
          await page
            .getByText(
              "OpenBot's storage is on F: now. OpenBot checks the free space again.",
            )
            .waitFor();
        } finally {
          await page.close();
        }
      }, 30_000);
  }
});

describe.skipIf(!asked)("the AI step while OpenBot installs behind it", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the form does not move and the page does not grow as the download comes and goes`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        // The entrance animation settles before anything is measured.
        await page.waitForTimeout(600);
        const before = await measure(page);
        expect(before.field).toBeGreaterThan(0);

        // The rest of OpenBot starts downloading, while the person types in the form.
        await page.evaluate(() => {
          (
            globalThis as unknown as { __fake: { download: unknown } }
          ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
        });
        await page.getByText("400.0 MB of 1.6 GB").waitFor();
        expect(await measure(page)).toEqual(before);

        // The download ends.
        await page.evaluate(() => {
          (
            globalThis as unknown as { __fake: { download: unknown } }
          ).__fake.download = null;
        });
        await page.getByText("400.0 MB of 1.6 GB").waitFor({ state: "hidden" });
        expect(await measure(page)).toEqual(before);

        // Everything is installed, and the row says so.
        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishSetUp: () => void } }
          ).__fake.finishSetUp(),
        );
        await page.getByText("OpenBot is installed").waitFor();
        expect(await measure(page)).toEqual(before);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/** Where the step's heading and its first row are: what a person is reading. */
async function anchors(page: Page) {
  const heading = await page
    // Only the Start that updates OpenBot (`#start`) asks.
    .getByRole("heading", { name: "Updating OpenBot" })
    .boundingBox();
  const first = await page
    .getByRole("listitem", { name: "Setting up OpenBot" })
    .boundingBox();
  const journey = await page.locator(".journey").boundingBox();
  const bar = await page.locator(".journey progress").boundingBox();
  const time = await page.locator(".journey-time").boundingBox();
  expect(first).not.toBeNull();
  expect(journey).not.toBeNull();
  expect(bar).not.toBeNull();
  expect(time).not.toBeNull();
  return {
    heading: heading?.y,
    first: first?.y,
    journey,
    bar,
    timeHeight: time?.height,
  };
}

/*
 * Seen on Windows: Start's card re-centred as rows came and went while OpenBot updated, so the
 * heading and the rows jumped up 31px when the update's row appeared, up 20px when its download
 * bar did, and down 20px when the bar went. The card is held from the top now, and the update is
 * the Start journey's: its download's measure sits on the journey's time line, so neither the
 * heading nor the rows move as it comes and goes.
 */
describe.skipIf(!asked)("the Start screen while OpenBot updates", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, nothing on screen moves as the update and its download come and go`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page, "#start");
        await page.locator(".cannot-cancel").waitFor();
        await page.locator(".journey").waitFor();
        await page.waitForTimeout(600);
        const before = await anchors(page);
        expect(before.heading).toBeGreaterThan(0);
        const said = page.locator(".journey-said");
        const time = page.locator(".journey-time");

        const emit = (payload: Record<string, unknown>) =>
          page.evaluate(
            (sent) =>
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:progress", sent),
            payload,
          );
        // The update begins: the journey says so.
        await emit({
          step: "release",
          ok: true,
          running: true,
          detail: "Downloading the update.",
        });
        await page
          .locator(".journey-said", { hasText: "Downloading the update" })
          .waitFor();
        expect(await anchors(page)).toEqual(before);
        const lines = await time.boundingBox();
        // Its download, measured on the journey's time line, and one bar on the screen.
        await emit({
          step: "images",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads: {
            done: 1,
            total: 5,
            bytes: 100_000_000,
            size: 944_200_000,
          },
        });
        await page
          .getByText("100.0 MB of 944.2 MB", { exact: false })
          .waitFor();
        expect(await anchors(page)).toEqual(before);
        expect((await time.boundingBox())?.height).toBe(lines?.height);
        expect(await page.getByRole("progressbar").count()).toBe(1);
        // The download ends, and its measure goes.
        await emit({
          step: "images",
          ok: true,
          running: false,
          detail: "Local software is downloaded (5/5).",
        });
        await page
          .getByText("100.0 MB of 944.2 MB", { exact: false })
          .waitFor({ state: "hidden" });
        expect(await anchors(page)).toEqual(before);
        // Its download done, the update is on to installing what it downloaded.
        expect(await said.textContent()).toBe("Installing the update");
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * David's decision for 1.0.2: on a Mac whose own Podman OpenBot can't use, the account step says
 * OpenBot needs its own and offers to pause theirs, with one button. The card, its button and the
 * background row are all in the window at the setup window's sizes, without the page growing.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each size for a look.
 */
describe.skipIf(!asked)("the offer to pause the person's Podman", () => {
  for (const [width, height] of [
    [1016, 839],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the offer and its button are in the window`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page, "#pause-podman");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Setting up this computer" })
          .waitFor();
        const card = page.getByRole("region", {
          name: "OpenBot needs its own Podman",
        });
        await card.waitFor();
        await page.waitForTimeout(400);
        const button = page.getByRole("button", { name: "Pause my Podman" });
        const box = await button.boundingBox();
        const behind = page.getByRole("listitem", {
          name: "Preparing OpenBot",
        });
        const foot = await page
          .locator(".account-layout .setup-body")
          .boundingBox();
        expect(box).not.toBeNull();
        expect(foot).not.toBeNull();
        if (box && foot) {
          // In the window, and inside the account step's scrollable body: seen at 720x560, cut in half.
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(foot.y + foot.height);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        expect(await behind.textContent()).toContain(
          "Waiting for you to pause your Podman.",
        );
        expect(
          await page.evaluate(() => ({
            page: document.documentElement.scrollHeight,
            window: window.innerHeight,
          })),
        ).toEqual({ page: height, window: height });
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/pause-podman-${width}x${height}.png`,
          });
        expect(
          await page.evaluate(() => {
            const button = [
              ...document.querySelectorAll<HTMLButtonElement>("button"),
            ].find(
              (button) => button.textContent?.trim() === "Pause my Podman",
            )!;
            button.focus();
            const b = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              b.x + b.width / 2,
              b.y + b.height / 2,
            );
            return (
              document.activeElement === button && !!hit && button.contains(hit)
            );
          }),
        ).toBe(true);
        if (width === 720) await page.keyboard.press("Enter");
        else await button.click();
        expect(
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter((call) => call === "allow_pause_podman"),
          ),
        ).toEqual(["allow_pause_podman"]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/** Goes from the first screen to "Connect your AI", as a first run does. */
async function toTheAiStep(page: Page, hash = "") {
  await open(page, hash);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
  // The entrance animation settles before anything is measured.
  await page.waitForTimeout(600);
}

describe.skipIf(!asked)("restored provider focus", () => {
  test("at 720x560, Change and Escape reveal the whole previous provider and reselection reveals the form start", async () => {
    const page = await browser.newPage({
      viewport: { width: 720, height: 560 },
    });
    try {
      await toTheAiStep(page);
      const heading = await page
        .getByRole("heading", { name: "Connect your AI" })
        .boundingBox();
      await page.getByText("Any OpenAI-compatible endpoint").click();
      await page.getByLabel("Base URL", { exact: true }).waitFor();
      for (const key of ["Enter", "Escape", "Enter", "Escape"]) {
        // Reading the first field leaves the form at the top before returning to the list.
        await page.evaluate(() => {
          document.querySelector<HTMLElement>(
            ".provider-layout .setup-body",
          )!.scrollTop = 0;
          document
            .querySelector<HTMLButtonElement>(".change-provider")!
            .focus();
        });
        await page.keyboard.press(key);
        await settled(page);
        const restored = await page.evaluate(() => {
          const body = document.querySelector<HTMLElement>(
            ".provider-layout .setup-body",
          )!;
          const focused = document.activeElement as HTMLInputElement;
          const tile = focused.closest(".tile")!;
          const bounds = body.getBoundingClientRect();
          const box = tile.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return {
            provider: focused.value,
            whole:
              box.top >= bounds.top &&
              box.bottom <= bounds.bottom &&
              box.left >= bounds.left &&
              box.right <= bounds.right,
            hit: !!hit && tile.contains(hit),
            overflow:
              document.documentElement.scrollHeight > innerHeight ||
              document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(restored).toEqual({
          provider: "openai-compatible",
          whole: true,
          hit: true,
          overflow: false,
        });
        expect(
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .boundingBox(),
        ).toEqual(heading);
        // Space activates the restored radio without a pointer scrolling it for us.
        await page.keyboard.press("Space");
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await settled(page);
        expect(
          await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(
              ".provider-layout .setup-body",
            )!;
            const bounds = body.getBoundingClientRect();
            const field = body.querySelector<HTMLInputElement>("#base")!;
            const box = field.getBoundingClientRect();
            return {
              atStart: body.scrollTop === 0,
              firstFieldWhole:
                box.top >= bounds.top && box.bottom <= bounds.bottom,
            };
          }),
        ).toEqual({ atStart: true, firstFieldWhole: true });
        expect(
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .boundingBox(),
        ).toEqual(heading);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
});

const PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "Google Gemini",
  "xAI",
  "TrustedRouter",
  "Privatemode",
  "Any OpenAI-compatible endpoint",
];

/*
 * Seen on Windows G (the default 1000x800 window): on "Connect your AI" the last providers sat under
 * the step's pinned foot, Continue and the background row, with a sliver of one tile's edge
 * showing, and nothing said the list went on. The flexible body now scrolls independently of
 * Continue, and each provider scrolls into view. At1000x800 every provider shows at once;
 * scrolling just the body's bottom padding is harmless.
 */
describe.skipIf(!asked)("Connect your AI with every provider", () => {
  for (const [width, height] of [
    [1000, 800],
    [1000, 600],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the authentication body is the one scroll area, and every provider is in view or plainly scrolls into view`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await toTheAiStep(page);
        const look = () =>
          page.evaluate(() => {
            const sheet = document.querySelector(
              "main > .sheet",
            ) as HTMLElement;
            const foot = sheet.querySelector(".step-footer") as HTMLElement;
            const top = sheet.getBoundingClientRect().top;
            const footTop = foot.getBoundingClientRect().top;
            const scrolling = [...document.querySelectorAll("*")]
              .filter((element) => {
                const { overflowY } = getComputedStyle(element);
                return (
                  /auto|scroll/.test(overflowY) &&
                  element.scrollHeight > element.clientHeight + 1
                );
              })
              .map((element) => element.className);
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const tiles = [
              ...sheet.querySelectorAll("fieldset.providers .tile"),
            ].map((tile) => {
              const box = tile.getBoundingClientRect();
              const at = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return {
                name: tile.querySelector(".tile-name")?.textContent ?? "",
                // Whole, above the foot, and nothing over it.
                shown:
                  box.top >= top - 1 &&
                  box.bottom <= footTop + 1 &&
                  Boolean(at && tile.contains(at)),
              };
            });
            return {
              scrolling,
              goesOn:
                body.scrollHeight - body.scrollTop > body.clientHeight + 1,
              tiles,
            };
          });
        const first = await look();
        expect(first.tiles.map((tile) => tile.name)).toEqual(PROVIDERS);
        if (height >= 800) {
          // The flexible body may scroll its bottom padding; every provider still shows whole.
          expect(first.tiles).toEqual(
            PROVIDERS.map((name) => ({ name, shown: true })),
          );
          expect(first.scrolling.every((name) => name === "setup-body")).toBe(
            true,
          );
          return;
        }
        expect(first.scrolling).toEqual(["setup-body"]);
        // Some are clipped by the body at this size, with more scrollable content below.
        expect(first.tiles.some((tile) => !tile.shown)).toBe(true);
        expect(first.goesOn).toBe(true);
        // A wheel over the list scrolls the card, and brings every provider into view.
        const seen = new Set(
          first.tiles.filter((tile) => tile.shown).map((tile) => tile.name),
        );
        await page.mouse.move(width / 2, height / 3);
        let now = first;
        for (let turn = 0; turn < 12 && now.goesOn; turn += 1) {
          await page.mouse.wheel(0, 90);
          await page.waitForTimeout(150);
          now = await look();
          for (const tile of now.tiles) if (tile.shown) seen.add(tile.name);
          expect(now.scrolling).toEqual(["setup-body"]);
        }
        expect([...seen].sort()).toEqual([...PROVIDERS].sort());
        // At the end of the body, the last provider is whole and no further content remains.
        expect(now.goesOn).toBe(false);
        expect(now.tiles[now.tiles.length - 1]?.shown).toBe(true);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * A ChatGPT plan signed in to by an earlier version went through Codex's sign-in, which a ChatGPT
 * plan's engine (the OpenAI Agents SDK, on OpenAI's Sign in with ChatGPT) can't use. The AI step
 * says so above the one button that fixes it, and the saved sign-in is not offered. A saved sign-in
 * from Sign in with ChatGPT is, and the step names the Bot it runs on.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each, light and dark.
 */
describe.skipIf(!asked)("Connect your AI on a ChatGPT plan", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`an earlier version's ChatGPT sign-in is asked for again, with one press (${colorScheme})`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        colorScheme,
      });
      try {
        // The plan it was on stays chosen, so the step opens on it. The screenshot is taken before
        // anything is asserted, so a run against an earlier window keeps one too.
        await toTheAiStep(page, "#chatgpt-changed");
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/chatgpt-sign-in-changed-${colorScheme}.png`,
          });
        await page
          .getByText(
            "ChatGPT's sign-in has changed. Sign in to ChatGPT again to keep using your plan.",
          )
          .waitFor({ state: "visible" });
        // One press: the sign-in itself. Nothing offers the saved one, and nothing says it will be
        // checked at Start.
        expect(
          await page
            .getByRole("button", { name: "Sign in with OpenAI" })
            .count(),
        ).toBe(1);
        expect(
          await page
            .getByRole("button", { name: "Use a saved ChatGPT sign-in" })
            .count(),
        ).toBe(0);
        expect(
          await page.getByText("will be checked when you start").count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`a saved ChatGPT sign-in runs on the OpenAI Agents SDK (${colorScheme})`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        colorScheme,
      });
      try {
        await toTheAiStep(page, "#chatgpt-saved");
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/chatgpt-saved-sign-in-${colorScheme}.png`,
          });
        await page.getByText("Your Bot will use OpenAI Agents SDK.").waitFor();
        expect(
          await page
            .getByText("ChatGPT's sign-in has changed", { exact: false })
            .count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * Seen on Windows G: the background row read "Installing OpenBot in the backgr..." beside its
 * "Step 3 of 4 · 4m 18s elapsed" badge. Its name is whole now, the badge on a line of its own, and
 * the row fits the height the sidebar's foot holds in every state, the foot where it was.
 */
describe.skipIf(!asked)(
  "the background row's name beside minutes of install",
  () => {
    for (const [width, height] of [
      [1016, 839],
      [1000, 800],
      [720, 560],
    ] as const) {
      test(`at ${width}x${height}, is read whole in Windows-wide type, and the row fits the sidebar's foot`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await toTheAiStep(page);
          await page.evaluate(() => {
            const real = Date.now;
            Date.now = () => real() + 258_000;
            // Wider type than this browser sets, as the foot's own test does: Windows' is.
            const wider = document.createElement("style");
            wider.textContent = ".rail-foot { letter-spacing: 0.12em; }";
            document.head.append(wider);
          });
          const read = () =>
            page.evaluate(() => {
              const foot = document.querySelector(
                "main > .rail > .rail-foot",
              ) as HTMLElement;
              const name = foot.querySelector(".step-label") as HTMLElement;
              const row = foot
                .querySelector(":scope > .steps")
                ?.getBoundingClientRect();
              const held = foot.getBoundingClientRect();
              return {
                name: name.textContent,
                cut: name.scrollWidth > name.clientWidth,
                badge: foot.querySelector(".step-status")?.textContent ?? "",
                fits:
                  (row?.bottom ?? 1e9) <= held.bottom + 0.5 &&
                  held.bottom <= window.innerHeight,
                foot: held.top,
              };
            });
          // Setting up, then downloading the rest with its bar and bytes, then installed.
          await page.getByText(/Setting up OpenBot on this computer/).waitFor();
          await page.waitForTimeout(1100);
          const plain = await read();
          expect(plain).toEqual({
            name: "Preparing OpenBot",
            cut: false,
            badge: expect.stringMatching(/^Step 3 of 4 · 4m \d+s elapsed$/),
            fits: true,
            foot: expect.any(Number),
          });
          await page.evaluate(() => {
            (
              globalThis as unknown as { __fake: { download: unknown } }
            ).__fake.download = { done: 481_800_000, total: 605_200_000 };
          });
          await page.getByText("481.8 MB of 605.2 MB").waitFor();
          expect(await read()).toEqual({ ...plain, badge: expect.any(String) });
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  },
);

/*
 * Seen on Windows G: the background row moved about 15 px sideways when a provider was chosen, as
 * the card stopped scrolling and its scrollbar went. With the scrollbars Windows draws, which
 * take room, the row and the step's providers must stay where they were. At1000x700 the
 * catalogue scrolls while the selected authentication panel fits, exercising scrollbar removal.
 */
describe.skipIf(!asked)(
  "with scrollbars that take room, as Windows draws them",
  () => {
    test("at 1000x700, the background row and the providers hold still as the page's scrollbar comes and goes", async () => {
      // Its own browser for the scrollbars, launched once and never closed (see sharedChromium).
      const drawn = await sharedChromium(
        () =>
          chromium.launch({
            channel: "chromium",
            ignoreDefaultArgs: ["--hide-scrollbars"],
          }),
        "chromium-scrollbars",
      );
      const page = await drawn.newPage({
        viewport: { width: 1000, height: 700 },
      });
      try {
        await toTheAiStep(page);
        // Make classic scrollbars deterministic on hosts that otherwise use overlays.
        await page.evaluate(() => {
          const style = document.createElement("style");
          style.textContent =
            ".provider-layout ::-webkit-scrollbar { width: 16px; }";
          document.head.append(style);
        });
        const where = () =>
          page.evaluate(() => {
            const sheet = document.querySelector(
              "main > .sheet",
            ) as HTMLElement;
            const row = document
              .querySelector("main > .rail > .rail-foot > .steps")
              ?.getBoundingClientRect();
            const tile = document
              .querySelector("fieldset.providers .tile")
              ?.getBoundingClientRect();
            const footer = sheet
              .querySelector<HTMLElement>(".setup-footer")!
              .getBoundingClientRect();
            return {
              footer: {
                left: footer.left,
                top: footer.top,
                width: footer.width,
              },
              scrolls:
                sheet.querySelector<HTMLElement>(".setup-body")!.scrollHeight >
                sheet.querySelector<HTMLElement>(".setup-body")!.clientHeight +
                  1,
              scrollbar: (() => {
                const body = sheet.querySelector<HTMLElement>(".setup-body")!;
                return body.offsetWidth - body.clientWidth > 2;
              })(),
              row: row && { left: row.left, width: row.width },
              tile: tile && { left: tile.left, width: tile.width },
            };
          });
        await settled(page);
        const listing = await where();
        expect(listing.scrolls).toBe(true);
        expect(listing.scrollbar).toBe(true);
        expect(listing.row?.width).toBeGreaterThan(0);
        // A provider chosen, the step fits, and the card has no scrollbar to draw.
        await page.getByText("Anthropic", { exact: true }).click();
        await page
          .getByRole("button", { name: "Choose a different provider" })
          .waitFor();
        await settled(page);
        const chosen = await where();
        expect(chosen.scrolls).toBe(false);
        expect(chosen.row).toEqual(listing.row);
        expect(chosen.tile).toEqual(listing.tile);
        expect(chosen.footer).toEqual(listing.footer);
        expect(chosen.tile?.left).toBe(chosen.footer.left);
      } finally {
        await page.close();
      }
    }, 30_000);
  },
);

/*
 * Seen on Windows K: on "Finishing setup" the usage data checkbox sat under the step's rows, and the
 * rows come one at a time. It was on screen and could be clicked from the step's first moment, and
 * then moved down 49 px three times in about three seconds as the second, third and fourth rows
 * arrived, 147 px in all. A click aimed at it landed on nothing, and the box stayed ticked. The
 * choice sits in its own footer now and holds its place for the whole step.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of the step's first and last moments at each size.
 */
describe.skipIf(!asked)("Finishing setup's usage data choice", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, holds its place from the step's first row to its last, and unticks where it was`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await toTheAiStep(page);
        await page.getByText("Anthropic", { exact: true }).click();
        await page
          .getByRole("tab", { name: "Use an API key", exact: true })
          .click();
        await page
          .getByLabel("Anthropic API key", { exact: true })
          .fill("a-key-for-this-test");
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page.getByRole("heading", { name: "Finishing setup" }).waitFor();
        const box = page.getByRole("checkbox");
        await box.waitFor();
        // The entrance animation settles before anything is measured.
        await page.waitForTimeout(600);
        /** Where the checkbox is in the window, and whether a click at its middle reaches it. */
        const where = async () => {
          const at = await box.boundingBox();
          const reached = await page.evaluate(() => {
            const found = document.querySelector(
              '.usage-choice input[type="checkbox"]',
            ) as HTMLInputElement;
            const rect = found.getBoundingClientRect();
            return (
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) === found
            );
          });
          return { x: at?.x, y: at?.y, reached };
        };
        const rows = () =>
          page.locator(".finishing-layout .steps > .step").count();
        const shots = process.env.OPENBOT_APP_SHOTS;
        const keep = async (moment: string) => {
          if (shots)
            await page.screenshot({
              path: `${shots}/finishing-setup-${moment}-${width}x${height}.png`,
            });
        };

        // The step's first moment: one current journey, setting up, and the choice already there to click.
        await page.locator(".journey").waitFor();
        const first = await where();
        expect(await rows()).toBe(0);
        expect(first.y).toBeGreaterThan(0);
        expect(first.reached).toBe(true);
        await keep("first-row");

        // Setting up ends, and the rest of the rows arrive one after another.
        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishSetUp: () => void } }
          ).__fake.finishSetUp(),
        );
        await page.locator(".cannot-cancel").waitFor();
        await page.waitForTimeout(600);
        expect(await rows()).toBe(3);
        await keep("last-row");
        expect(await where()).toEqual(first);

        // A click where the box was at the step's first moment unticks it.
        await page.mouse.click((first.x ?? 0) + 6, (first.y ?? 0) + 6);
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter(
              (call) => call === "plugin:openbot-desktop|set_usage_data",
            ),
          ),
        ).toEqual(["plugin:openbot-desktop|set_usage_data"]);
      } finally {
        await page.close();
      }
    }, 40_000);
  }
});

/*
 * Seen on a clean Mac's first install: Finishing setup, with its usage-data checkbox, was on screen
 * for about 10 seconds before OpenBot opened by itself, too short to read the choice or untick it.
 * Once OpenBot is up it stays now, saying OpenBot is ready, with Open OpenBot under the choice, in
 * view at both window sizes, light and dark. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of it.
 */
describe.skipIf(!asked)("Finishing setup once OpenBot is ready", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const)
      test(`at ${width}x${height} (${colorScheme}), waits for Open OpenBot under the choice, which an untick before it keeps`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        try {
          await toTheAiStep(page);
          await page.getByText("Anthropic", { exact: true }).click();
          await page
            .getByRole("tab", { name: "Use an API key", exact: true })
            .click();
          await page
            .getByLabel("Anthropic API key", { exact: true })
            .fill("a-key-for-this-test");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Finishing setup" })
            .waitFor();
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishSetUp: () => void } }
            ).__fake.finishSetUp(),
          );
          await page.locator(".cannot-cancel").waitFor();
          const working = await page.locator(".lede").textContent();
          expect(working).toBe(
            "OpenBot is setting up on this computer. This can take a few minutes.",
          );
          await settled(page);
          const before = await page.getByRole("checkbox").boundingBox();
          // OpenBot comes up: the screen stays, and says so.
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishStart: () => void } }
            ).__fake.finishStart(),
          );
          const open = page.getByRole("button", {
            name: "Open OpenBot",
            exact: true,
          });
          await open.waitFor();
          await settled(page);
          await page.waitForTimeout(400);
          const shots = process.env.OPENBOT_APP_SHOTS;
          if (shots)
            await page.screenshot({
              path: `${shots}/finishing-setup-ready-${width}x${height}-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
            });
          const calls = () =>
            page.evaluate(
              () =>
                (globalThis as unknown as { __fake: { calls: string[] } })
                  .__fake.calls,
            );
          expect(await calls()).not.toContain("show_openbot");
          expect(await page.locator(".lede").textContent()).toBe(
            "OpenBot is ready on this computer.",
          );
          expect(await page.locator(".cannot-cancel").count()).toBe(0);
          expect(await page.locator(".step-spinner").count()).toBe(0);
          // The choice, then the button, both in the window as it is, nothing to scroll to.
          const box = await page.getByRole("checkbox").boundingBox();
          const button = await open.boundingBox();
          expect(box).not.toBeNull();
          expect(button).not.toBeNull();
          // The button arriving never moves the choice a click may be aimed at.
          expect(box).toEqual(before);
          expect(button?.y ?? 0).toBeGreaterThan(box?.y ?? 0);
          expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThanOrEqual(
            height,
          );
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth,
            ),
          ).toBe(true);

          // Untick, then Open OpenBot: the untick is saved before OpenBot opens.
          await page.getByRole("checkbox").click();
          await page.waitForTimeout(200);
          await open.click();
          await page.waitForTimeout(400);
          const made = await calls();
          const untick = made.lastIndexOf(
            "plugin:openbot-desktop|set_usage_data",
          );
          expect(untick).toBeGreaterThan(-1);
          expect(made.indexOf("show_openbot")).toBeGreaterThan(untick);
        } finally {
          await page.close();
        }
      }, 40_000);
});

/*
 * Seen on a Mac's first install: on Finishing setup, "Connecting OpenBot" stopped with "Setup
 * stopped partway through with an error. Retry. If it stops again, copy the logs below.", and the
 * card had nothing below it but Retry. The logs it names are in the card now, and in view.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of the stopped card.
 */
describe.skipIf(!asked)("Finishing setup when a step stops", () => {
  test("offers the logs its sentence names, in view", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toTheAiStep(page, "#connect-fails");
      await page.getByText("Anthropic", { exact: true }).click();
      await page
        .getByRole("tab", { name: "Use an API key", exact: true })
        .click();
      await page
        .getByLabel("Anthropic API key", { exact: true })
        .fill("a-key-for-this-test");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("heading", { name: "Finishing setup" }).waitFor();
      await page.evaluate(() =>
        (
          globalThis as unknown as { __fake: { finishSetUp: () => void } }
        ).__fake.finishSetUp(),
      );
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      await page.waitForTimeout(600);
      const shots = process.env.OPENBOT_APP_SHOTS;
      if (shots)
        await page.screenshot({
          path: `${shots}/finishing-setup-stopped-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
        });
      const connect = await page
        .getByRole("listitem", { name: "Connecting OpenBot" })
        .textContent();
      expect(connect).toContain("copy the logs below");
      const copy = page.getByRole("button", { name: "Copy logs", exact: true });
      expect(await copy.count()).toBe(1);
      expect(
        await page
          .getByRole("button", { name: "Save to a file", exact: true })
          .count(),
      ).toBe(1);
      // In the window as it opens, under the row that names it: nothing to scroll to.
      const [row, button] = await Promise.all([
        page
          .getByRole("listitem", { name: "Connecting OpenBot" })
          .boundingBox(),
        copy.boundingBox(),
      ]);
      expect(button).not.toBeNull();
      expect(button?.y ?? 0).toBeGreaterThan(row?.y ?? 0);
      expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThanOrEqual(800);
    } finally {
      await page.close();
    }
  }, 40_000);
});

/*
 * An update this computer has no room for. On Windows the sentence with the figures sat at the foot
 * of the window, in a "That didn't finish" box under "OpenBot is stopped / ready to reopen", a row
 * that said "OpenBot did not start." and a second copy of the logs. What it needs is the heading and
 * the sentence under it, with Retry beside it, in the window as it opens; the row that stopped says
 * why; the logs are offered once. For OpenBot's own update, and for the back end's, which the window
 * runs first. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each, light and dark.
 */
describe.skipIf(!asked)("an update this computer has no room for", () => {
  const cases = [
    {
      hash: "#update-short",
      said: "This computer has 7.4 GB of free space on drive C:, and OpenBot needs about 13 GB to update. Free up some space, then Retry.",
    },
    {
      hash: "#backend-short",
      said: "This Mac has 8.2 GB of free space, and OpenBot needs about 13 GB to update. Free up some space, then Retry.",
    },
  ];
  for (const { hash, said } of cases)
    for (const colorScheme of ["light", "dark"] as const)
      test(`says what it needs first, with Retry beside it (${hash.slice(1)}, ${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 800 },
          colorScheme,
        });
        try {
          await open(page, hash);
          // Stopped, whatever it is headed.
          await page
            .getByRole("button", { name: "Retry", exact: true })
            .waitFor();
          await page.waitForTimeout(600);
          const shots = process.env.OPENBOT_APP_SHOTS;
          if (shots)
            await page.screenshot({
              path: `${shots}/no-room-${hash.slice(1)}-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
            });
          const seen = await page.evaluate(() => {
            const box = (element: Element | null | undefined) => {
              const rect = element?.getBoundingClientRect();
              return rect ? { top: rect.top, bottom: rect.bottom } : null;
            };
            const lede = document.querySelector("main .lede");
            const retry = [...document.querySelectorAll("main button")].filter(
              (button) => button.textContent === "Retry",
            );
            const failed = [...document.querySelectorAll("main li")].filter(
              (row) => row.textContent?.includes("Failed"),
            );
            const named = (label: string) =>
              [...document.querySelectorAll("main button")].filter(
                (button) => button.textContent === label,
              ).length;
            const ledeBox = box(lede);
            const retryBox = box(retry[0]);
            const rowsBox = box(document.querySelector("main li"));
            const text = document.querySelector("main")?.textContent ?? "";
            return {
              heading: document.querySelector("main h1")?.textContent,
              lede: lede?.textContent,
              retries: retry.length,
              // Retry under the sentence and above the rows, in the window as it opens.
              retryUnderSentence: (retryBox?.top ?? 0) > (ledeBox?.bottom ?? 0),
              retryAboveRows: (retryBox?.bottom ?? 0) < (rowsBox?.top ?? 0),
              retryInView: (retryBox?.bottom ?? 900) <= 800,
              failedRows: failed.length,
              failedRowSaysWhy: failed.some((row) =>
                row.textContent?.includes("Not enough free space to update."),
              ),
              saysDidNotStart: text.includes("did not start"),
              saysDidNotFinish: text.includes("That didn’t finish"),
              saysReadyToReopen: text.includes("ready to reopen"),
              copyLogs: named("Copy logs"),
              saveToAFile: named("Save to a file"),
            };
          });
          expect(seen).toEqual({
            heading: "OpenBot needs more free space to update",
            lede: said,
            retries: 1,
            retryUnderSentence: true,
            retryAboveRows: true,
            retryInView: true,
            failedRows: 1,
            failedRowSaysWhy: true,
            saysDidNotStart: false,
            saysDidNotFinish: false,
            saysReadyToReopen: false,
            copyLogs: 1,
            saveToAFile: 1,
          });
        } finally {
          await page.close();
        }
      }, 40_000);
});

/*
 * An image list something outside OpenBot deleted. Start used to say "This version of OpenBot does
 * not include the Bot you picked. Go back and choose another, or update OpenBot.", and every Retry
 * failed the same way. Start says it is an unfinished install now, so the window runs Install by
 * itself (which downloads only the list again) before it starts. Offline here, so that install
 * fails: the window is on Installing OpenBot with the download row failed and Retry installation,
 * and says nothing about the Bot. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot, light and dark.
 */
describe.skipIf(!asked)("a Start whose image list is gone", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`installs again by itself, and offline says the download failed, not the Bot (${colorScheme})`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        colorScheme,
      });
      try {
        await open(page, "#image-list-gone");
        await page
          .getByRole("button", { name: "Retry installation", exact: true })
          .waitFor();
        await page.waitForTimeout(600);
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/image-list-gone-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
          });
        const seen = await page.evaluate(() => {
          const calls = (
            globalThis as unknown as { __fake: { calls: string[] } }
          ).__fake.calls;
          const text = document.querySelector("main")?.textContent ?? "";
          const failed = [...document.querySelectorAll("main li")].filter(
            (row) => row.textContent?.includes("Failed"),
          );
          return {
            heading: document.querySelector("main h1")?.textContent,
            failedRows: failed.length,
            failedDownload: failed.some((row) =>
              row.textContent?.includes("Downloading OpenBot"),
            ),
            blamesTheBot: text.includes("does not include"),
            saysDidNotStart: text.includes("did not start"),
            starts: calls.filter((call) => call === "start_stack").length,
            installs: calls.filter((call) => call === "prepare_installation")
              .length,
          };
        });
        expect(seen).toEqual({
          heading: "Installing OpenBot",
          failedRows: 1,
          failedDownload: true,
          blamesTheBot: false,
          saysDidNotStart: false,
          starts: 1,
          installs: 1,
        });
      } finally {
        await page.close();
      }
    }, 40_000);
});

/** Opens a relaunch whose Start updates OpenBot, at its last step, OpenBot opening. */
async function toStart(page: Page) {
  await open(page, "#start");
  await page.locator(".cannot-cancel").waitFor();
  await page.locator(".journey").waitFor();
  await page.waitForTimeout(600);
}

const emitProgress = (page: Page, payload: Record<string, unknown>) =>
  page.evaluate(
    (sent) =>
      (
        globalThis as unknown as {
          __fake: { emit: (name: string, payload: unknown) => void };
        }
      ).__fake.emit("setup:progress", sent),
    payload,
  );

describe.skipIf(!asked)("the Start screen's words and card", () => {
  /*
   * Seen on Windows G: "Starting OpenBot" said "This usually takes a minute or two" over a card
   * that said "About 3 minutes left", and the start took four. The card's time comes from how long
   * each part takes; the heading gives none of its own.
   */
  test("the time is said once, by the card", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const said = await page.evaluate(() => ({
        heading: document.querySelector("main h1")?.textContent,
        lede: document.querySelector(".journey-description")?.textContent ?? "",
        card: document.querySelector(".journey-time")?.textContent ?? "",
      }));
      // This Start updates OpenBot, and its heading says so.
      expect(said.heading).toBe("Updating OpenBot");
      expect(said.lede).toBe("OpenBot opens by itself when it's ready.");
      expect(said.lede).not.toMatch(/minute|second|hour/i);
      expect(said.card).toMatch(/left/);
    } finally {
      await page.close();
    }
  }, 30_000);

  /*
   * Seen on Windows G: the card grew a line and shrank again as what it said changed, and moved the
   * rows under it. Held at one fixed 130 px instead, its usual one-line form had an empty band under
   * the bar. It is as tall as what it says, in its own padding, and what changes is said in place:
   * "Taking longer than usual, still working" takes the time line's place and adds no line.
   * Docker Desktop's hand-off holds its full directions while it shows.
   */
  test("the card fits what it says, and nothing moves as its time line changes", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const measure = () =>
        page.evaluate(() => {
          const card = document
            .querySelector(".journey")
            ?.getBoundingClientRect();
          const words = document
            .querySelector(".journey-said")
            ?.getBoundingClientRect();
          const bar = document
            .querySelector(".journey progress")
            ?.getBoundingClientRect();
          const time = document.querySelector(".journey-time") as HTMLElement;
          return {
            card: card?.height ?? 0,
            row: document
              .querySelector('[aria-label="Setting up OpenBot"]')
              ?.getBoundingClientRect().top,
            // The padding above what it says, and under the bar.
            above: (words?.top ?? 0) - (card?.top ?? 0),
            below: (card?.bottom ?? 0) - (bar?.bottom ?? 0),
            time: time.textContent ?? "",
            said: document.querySelector(".journey-said")?.textContent ?? "",
            cut: time.scrollWidth > time.clientWidth,
          };
        });
      const emit = (downloads: Record<string, number>) =>
        emitProgress(page, {
          step: "images",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads,
        });
      // OpenBot updating itself, its download under way, as on Windows G.
      await emitProgress(page, {
        step: "release",
        ok: true,
        running: true,
        detail: "Downloading the update.",
      });
      await emit({
        done: 1,
        total: 5,
        bytes: 190_900_000,
        size: 944_400_000,
        bytesPerSecond: 12_000_000,
      });
      await page.getByText(/190\.9 MB of 944\.4 MB/).waitFor();
      await page.waitForTimeout(600);
      const usual = await measure();
      expect(Math.abs(usual.below - usual.above)).toBeLessThanOrEqual(2);
      // The bytes are said with the download they count; the time line is the bar's, the whole
      // Start's (Windows K: "304.0 MB of 317.0 MB" read as the measure of a bar a third full).
      expect(usual.time).toMatch(/left · \d+s so far$/);
      expect(usual.time).not.toContain("MB");
      expect(usual.said).toBe("Downloading the update · 190.9 MB of 944.4 MB");
      expect(usual.cut).toBe(false);
      // Every byte in, its last part unpacking, and fifteen minutes on: taking longer than usual.
      await emit({
        done: 4,
        total: 5,
        bytes: 944_400_000,
        size: 944_400_000,
        bytesPerSecond: 0,
      });
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const real = Date.now;
        Date.now = () => real() + 900_000;
      });
      await page.getByText(/Taking longer than usual/).waitFor();
      const slow = await measure();
      expect(slow.time).toBe("Taking longer than usual, still working");
      expect(slow.said).toBe(
        "Unpacking the update (5 of 5) · 944.4 MB downloaded",
      );
      expect(slow.cut).toBe(false);
      expect({ card: slow.card, row: slow.row }).toEqual({
        card: usual.card,
        row: usual.row,
      });
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const { width, height } of [
    { width: 1000, height: 800 },
    { width: 720, height: 560 },
  ]) {
    test(`Docker Desktop's hand-off keeps its full directions and height at ${width}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await toStart(page);
        await settled(page);
        const measure = () =>
          page.evaluate(() => {
            const said = document.querySelector<HTMLElement>(".journey-said")!;
            const words = document.createRange();
            words.selectNodeContents(said);
            const text = words.getBoundingClientRect();
            const title = said.getBoundingClientRect();
            const card = document
              .querySelector(".journey")!
              .getBoundingClientRect();
            const natural = said.cloneNode(true) as HTMLElement;
            natural.style.cssText = `position: absolute; width: ${title.width}px; min-height: 0; height: auto; -webkit-line-clamp: unset;`;
            said.parentElement!.append(natural);
            const naturalHeight = natural.getBoundingClientRect().height;
            natural.remove();
            return {
              card: card.height,
              title: title.height,
              naturalHeight,
              fullText:
                text.top >= title.top - 1 &&
                text.bottom <= title.bottom + 1 &&
                text.left >= title.left - 1 &&
                text.right <= title.right + 1,
              insideCard: text.bottom <= card.bottom && text.top >= card.top,
              progress: document
                .querySelector(".journey progress")!
                .getBoundingClientRect().top,
              rows: document
                .querySelector('[aria-label="Setting up OpenBot"]')!
                .getBoundingClientRect().top,
            };
          });
        const usual = await measure();
        const handOff = async (detail: string) => {
          await emitProgress(page, {
            step: "engine",
            ok: true,
            running: true,
            elsewhere: true,
            detail,
          });
          await page
            .locator(".journey-said", { hasText: detail.slice(0, 30) })
            .waitFor();
          await settled(page);
          return measure();
        };
        const starting = await handOff(
          "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.",
        );
        const waiting = await handOff(
          "Docker Desktop hasn't started yet. It may be waiting for you. Accept its terms there.",
        );
        expect(starting.naturalHeight).toBeGreaterThan(waiting.naturalHeight);
        for (const state of [starting, waiting]) {
          expect(state.fullText).toBe(true);
          expect(state.insideCard).toBe(true);
          expect(state.title).toBeGreaterThanOrEqual(state.naturalHeight);
        }
        expect(starting.card).toBeCloseTo(
          usual.card + starting.naturalHeight - usual.title,
          3,
        );
        expect({
          card: waiting.card,
          progress: waiting.progress,
          rows: waiting.rows,
        }).toEqual({
          card: starting.card,
          progress: starting.progress,
          rows: starting.rows,
        });
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  /*
   * Seen on Windows G: Cancel went at step 4 and the card shrank. Cancel stops the setup's own
   * steps; the last, OpenBot starting or updating, can't be stopped partway. Its place says so, in
   * a button's height.
   */
  test("at its last step, the place of Cancel says why it can't be cancelled", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(
        0,
      );
      const note = page.locator(".cannot-cancel");
      // This Start updates OpenBot (`upgrade_due` answers a move), so it is said as the update.
      expect(await note.textContent()).toBe(
        "You can't cancel this last step. Stopping it partway could leave the update half done.",
      );
      expect((await note.boundingBox())?.height).toBe(40);
      // OpenBot updating itself, as on Windows G.
      await emitProgress(page, {
        step: "release",
        ok: true,
        running: true,
        detail: "Downloading the update.",
      });
      await page
        .locator(".cannot-cancel", { hasText: "the update half done" })
        .waitFor();
      expect((await note.boundingBox())?.height).toBe(40);
    } finally {
      await page.close();
    }
  }, 30_000);
});

/*
 * A dogfooding report: the screen OpenBot Desktop shows while it updates OpenBot is a strange one
 * for an app, and said nothing of why. It is headed as the self-contained OpenBot's update now, and
 * under its progress says that everything runs on this computer, then offers OpenBot for Business
 * with a link to book a demo. In light and dark, progress comes first and the note follows in the
 * shared scrolling body. The note can be read whole without moving the fixed heading.
 * Docker Desktop's hand-off makes the journey taller, which previously scrolled the card by
 * 12px: while it shows, the note keeps its heading and the pitch and leaves out the sentence between.
 * Run with `OPENBOT_APP_ENGINE=webkit` too, the engine the Mac window draws with.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each, taken before anything is asserted.
 */
const DOCKER_STARTING =
  "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.";

/** The update screen as a person sees it: its words, and where the progress and the note sit. */
describe.skipIf(!asked)("approved layout: shutdown Progress rail", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const)
      test(`${width}x${height} ${colorScheme}: native stages, optional cleanup and failure stay reachable`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        type QuitRow = {
          step: string;
          ok: boolean;
          running: boolean;
          detail: string;
        };
        let seq = 0;
        const emit = async (steps: QuitRow[]) => {
          await page.evaluate(
            ({ seq, steps }) =>
              globalThis.__workbench!.emit("quit:progress", { seq, steps }),
            { seq: ++seq, steps },
          );
          await page
            .getByRole("heading", {
              name: "Shutting down OpenBot",
              exact: true,
            })
            .waitFor();
          await settled(page);
        };
        const done = (step: string): QuitRow => ({
          step,
          ok: true,
          running: false,
          detail: "",
        });
        const current = (step: string): QuitRow => ({
          step,
          ok: true,
          running: true,
          detail: "Waiting for this shutdown operation to finish.",
        });
        let headingTop: number | undefined,
          footerTop: number | undefined,
          fraction = 0;
        const check = async (operation: string, count: number) => {
          const seen = await page.evaluate(() => {
            const sheet = document.querySelector<HTMLElement>(".quit-layout")!;
            const rail =
              document.querySelector<HTMLElement>("main > .quit-rail")!;
            const current = sheet.querySelector<HTMLElement>(".quit-current")!;
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const footer = sheet.querySelector<HTMLElement>(".setup-footer")!;
            const r = rail.getBoundingClientRect(),
              c = current.getBoundingClientRect(),
              b = body.getBoundingClientRect(),
              f = footer.getBoundingClientRect();
            const active = rail.querySelector<HTMLElement>(
              ".step:has(.mark.active)",
            );
            const detail = active?.querySelector<HTMLElement>(".detail");
            return {
              pageFits:
                document.documentElement.scrollHeight <= innerHeight &&
                document.documentElement.scrollWidth <= innerWidth,
              horizontal: [sheet, rail, current, body].some(
                (el) => el.scrollWidth > el.clientWidth + 1,
              ),
              columns:
                r.right <= c.left && r.left >= 0 && c.right <= innerWidth,
              insetPanel:
                sheet.getBoundingClientRect().top >= 9 &&
                sheet.getBoundingClientRect().right <= innerWidth - 9 &&
                getComputedStyle(sheet).borderTopWidth === "1px" &&
                Number.parseFloat(getComputedStyle(sheet).borderRadius) > 0,
              footerFits: b.bottom <= f.top + 1 && f.bottom <= innerHeight,
              headingTop: rail.querySelector("h1")!.getBoundingClientRect().top,
              footerTop: f.top,
              stages: rail.querySelectorAll(".step").length,
              operation: current.querySelector(".journey-said")?.textContent,
              bars: sheet.querySelectorAll("progress").length,
              fraction: Number(
                sheet.querySelector("progress")?.getAttribute("value"),
              ),
              spinners: sheet.querySelectorAll(".step-spinner").length,
              railSpinners: rail.querySelectorAll(".step-spinner").length,
              buttons: sheet.querySelectorAll("button").length,
              activeDetailVisible: !!detail && detail.offsetHeight > 0,
              explanation: footer.textContent,
            };
          });
          expect(seen.pageFits).toBe(true);
          expect(seen.horizontal).toBe(false);
          expect(seen.columns).toBe(true);
          expect(seen.insetPanel).toBe(true);
          expect(seen.footerFits).toBe(true);
          if (headingTop === undefined) headingTop = seen.headingTop;
          else expect(seen.headingTop).toBe(headingTop);
          if (footerTop === undefined) footerTop = seen.footerTop;
          else expect(seen.footerTop).toBe(footerTop);
          expect(seen.stages).toBe(count);
          expect(seen.operation).toBe(operation);
          expect(seen.bars).toBe(1);
          expect(seen.fraction).toBeGreaterThanOrEqual(fraction);
          fraction = seen.fraction;
          expect(seen.spinners).toBe(1);
          expect(seen.railSpinners).toBe(0);
          expect(seen.buttons).toBe(0);
          expect(seen.activeDetailVisible).toBe(false);
          expect(seen.explanation).toBe(
            "OpenBot is stopping what it started on this computer, then it closes.",
          );
        };
        try {
          await open(page);
          await page
            .getByRole("heading", { name: "Set up OpenBot", exact: true })
            .waitFor();
          await emit([current("finish-update")]);
          await check("Finishing the update so nothing is left half done", 1);
          expect(
            await page
              .getByText("Starting your Podman again", { exact: true })
              .count(),
          ).toBe(0);
          expect(
            await page
              .getByText("Stopping the software OpenBot runs on", {
                exact: true,
              })
              .count(),
          ).toBe(0);
          await emit([done("finish-update"), current("stop-openbot")]);
          await check("Closing OpenBot's apps", 2);
          await emit([
            done("finish-update"),
            done("stop-openbot"),
            current("stop-intelligence"),
          ]);
          await check("Closing OpenBot's services", 3);
          await emit([
            done("finish-update"),
            done("stop-openbot"),
            done("stop-intelligence"),
            current("stop-engine"),
          ]);
          await check("Stopping the software OpenBot runs on", 4);
          await emit([
            done("finish-update"),
            done("stop-openbot"),
            done("stop-intelligence"),
            done("stop-engine"),
            current("start-your-podman"),
          ]);
          await check("Starting your Podman again", 5);
          // A stale native packet must not replace the newest phase.
          await page.evaluate(() =>
            globalThis.__workbench!.emit("quit:progress", {
              seq: 1,
              steps: [],
            }),
          );
          await check("Starting your Podman again", 5);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/shutdown-rail-${width}x${height}-${colorScheme}.png`,
            });
          const failureDetail =
            "Your Podman did not start again. Its machine still needs attention. ".repeat(
              12,
            );
          await emit([
            done("finish-update"),
            done("stop-openbot"),
            done("stop-intelligence"),
            done("stop-engine"),
            {
              step: "start-your-podman",
              ok: false,
              running: false,
              detail: failureDetail,
            },
          ]);
          expect(
            await page.getByRole("region", { name: "How far along" }).count(),
          ).toBe(0);
          expect(
            await page
              .getByText(
                "Part of it could not be stopped. OpenBot says what happened the next time it opens.",
                { exact: true },
              )
              .count(),
          ).toBe(1);
          const failed = await page.evaluate(() => {
            const sheet = document.querySelector<HTMLElement>(".quit-layout")!;
            const rail =
              document.querySelector<HTMLElement>("main > .quit-rail")!;
            const detail = rail.querySelector<HTMLElement>(
              ".step:has(.mark.bad) .detail",
            )!;
            detail.scrollIntoView({ block: "end" });
            const d = detail.getBoundingClientRect(),
              r = rail.getBoundingClientRect();
            return {
              detail: detail.textContent,
              visible: detail.offsetHeight > 0,
              reachable: d.bottom <= r.bottom + 1,
              spinners: sheet.querySelectorAll(".step-spinner").length,
              buttons: sheet.querySelectorAll("button").length,
              fits:
                document.documentElement.scrollHeight <= innerHeight &&
                document.documentElement.scrollWidth <= innerWidth,
            };
          });
          expect(failed).toEqual({
            detail: failureDetail,
            visible: true,
            reachable: true,
            spinners: 0,
            buttons: 0,
            fits: true,
          });
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/shutdown-rail-${width}x${height}-${colorScheme}-failure.png`,
            });
        } finally {
          await page.close();
        }
      }, 30000);
});

function updateScreen(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".sheet.update-layout")!;
    const body = sheet.querySelector<HTMLElement>(".setup-body")!;
    const rail = document.querySelector<HTMLElement>("main > .update-history")!;
    const heading = rail.querySelector("h1");
    const box = (element: Element | null) => {
      const r = element?.getBoundingClientRect();
      return r
        ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
        : null;
    };
    return {
      insetPanel:
        sheet.getBoundingClientRect().top >= 9 &&
        sheet.getBoundingClientRect().right <= innerWidth - 9 &&
        getComputedStyle(sheet).borderTopWidth === "1px" &&
        Number.parseFloat(getComputedStyle(sheet).borderRadius) > 0,
      heading: heading?.textContent,
      headingBox: box(heading),
      rightHeadings: sheet.querySelectorAll("h1").length,
      pageHeadings: document.querySelectorAll("h1").length,
      railBox: box(rail),
      currentBox: box(sheet),
      bodyBox: box(body),
      operation: box(sheet.querySelector(".journey")),
      reassurance: box(sheet.querySelector(".update-data-reassurance")),
      stages: [...rail.querySelectorAll(".steps > .step")].map((row) => ({
        name: row.getAttribute("aria-label"),
        box: box(row),
      })),
      promo: sheet.querySelectorAll(".self-contained").length,
      sidebars: document.querySelectorAll("main > .rail").length,
      bars: sheet.querySelectorAll("progress").length,
      sideways: [body, rail, sheet].some(
        (el) => el.scrollWidth > el.clientWidth + 1,
      ),
      bytes: sheet.querySelector(".journey-bytes")?.textContent,
      timing: sheet.querySelector(".journey-time")?.textContent,
      spinners: document.querySelectorAll(".step-spinner").length,
      overflow: document.documentElement.scrollHeight > window.innerHeight,
      reassuranceCopy: sheet.querySelector(".update-data-reassurance")
        ?.textContent,
      safety: sheet.querySelector(".cannot-cancel")?.textContent,
    };
  });
}

describe.skipIf(!asked)("approved layout: update Progress rail", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const)
      test(`${width}x${height} ${colorScheme}: real stages, one operation and data reassurance fit`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        try {
          await toStart(page);
          await emitProgress(page, {
            step: "release",
            ok: true,
            running: true,
            detail: "Downloading the update.",
          });
          await page
            .locator(".journey-said", { hasText: "Downloading the update" })
            .waitFor();
          const seen = await updateScreen(page);
          expect(seen.heading).toBe("Updating OpenBot");
          expect(seen.insetPanel).toBe(true);
          expect(seen.sidebars).toBe(1);
          expect(seen.pageHeadings).toBe(1);
          expect(seen.rightHeadings).toBe(0);
          expect(seen.railBox!.right).toBeLessThanOrEqual(
            seen.currentBox!.left,
          );
          expect(seen.promo).toBe(0);
          expect(seen.bars).toBe(1);
          expect(seen.sideways).toBe(false);
          expect(seen.overflow).toBe(false);
          expect(seen.reassuranceCopy).toContain(
            "Your Bots, sign-ins and data stay as they are.",
          );
          expect(seen.safety).toContain("You can't cancel this last step");
          expect(seen.stages.map((row) => row.name)).toEqual([
            "Setting up OpenBot",
            "Connecting OpenBot",
            "Getting OpenBot ready",
            "Opening OpenBot",
          ]);
          const stages = seen.stages.map((row) => row.box!);
          expect(
            stages.every((row) => Math.abs(row.left - stages[0].left) < 1),
          ).toBe(true);
          expect(
            stages.every(
              (row, i) => i === 0 || row.top >= stages[i - 1].bottom,
            ),
          ).toBe(true);
          expect(seen.spinners).toBe(1);
          expect(seen.timing).toMatch(/left.*so far/);
          expect(seen.operation!.top).toBeGreaterThanOrEqual(seen.bodyBox!.top);
          expect(seen.reassurance!.bottom).toBeLessThanOrEqual(
            seen.bodyBox!.bottom + 1,
          );
          await emitProgress(page, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading local software.",
            downloads: {
              done: 2,
              total: 5,
              bytes: 600_000_000,
              size: 1_200_000_000,
            },
          });
          const downloading = await updateScreen(page);
          expect(downloading.bytes).toContain("600.0 MB of 1.2 GB");
          expect(downloading.timing).not.toMatch(/MB|GB/);
          await emitProgress(page, {
            step: "images",
            ok: true,
            running: false,
            detail: "Downloaded.",
          });
          await emitProgress(page, {
            step: "engine",
            ok: true,
            running: true,
            elsewhere: true,
            detail: DOCKER_STARTING,
          });
          await page.locator(".journey.handing-off").waitFor();
          const handoff = await updateScreen(page);
          expect(handoff.headingBox).toEqual(seen.headingBox);
          expect(handoff.reassurance!.bottom).toBeLessThanOrEqual(
            handoff.bodyBox!.bottom + 1,
          );
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/update-progress-rail-${width}x${height}-${colorScheme}.png`,
            });
        } finally {
          await page.close();
        }
      }, 30000);
});

describe.skipIf(!asked)(
  "the account step for a person already signed in",
  () => {
    /*
     * Seen on Windows G: for two seconds before the license agreement, a signed-in person saw the
     * signed-out pitch ("It requires a free license key", "does NOT send traffic data") over
     * "Checking your OpenBot account". The step says only that it is checking, until it knows.
     */
    test("while the sign-in is checked, the screen says so and nothing about signing in", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      try {
        await open(page, "#licence-slow");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Your OpenBot account" })
          .waitFor();
        const text = await page.evaluate(
          () =>
            (document.querySelector("main > .sheet") as HTMLElement).innerText,
        );
        expect(text).toContain("Checking your OpenBot account");
        expect(text).not.toMatch(
          /license key|traffic data|Self-contained|sign in/i,
        );
        await page
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
      } finally {
        await page.close();
      }
    }, 30_000);

    /*
     * Seen on Windows G: signed in already, the license screen's background row still said "The rest
     * of the install starts after you sign in and accept the license agreement".
     */
    test("the background row waits on the agreement only", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      try {
        await open(page, "#licence");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
        const row = page.getByRole("listitem", {
          name: "Preparing OpenBot",
        });
        await page.getByText(/The rest of the install starts/).waitFor();
        const said = (await row.textContent()) ?? "";
        expect(said).toContain(
          "The rest of the install starts after you accept the license agreement.",
        );
        expect(said).not.toMatch(/sign in/i);
      } finally {
        await page.close();
      }
    }, 30_000);
  },
);

/*
 * When this app is too old for its OpenBot (`client_version.rs`), the window says the shell's
 * sentence and offers its one way on, Update and restart, in view and uncovered, without outgrowing
 * the window. Beside them problems the screen always had, a sign-in that ended and a found-running
 * OpenBot that fails to show, for comparison. With `OPENBOT_SHOTS_DIR` set, each is
 * saved there in light and dark, at the window's default size.
 */
describe.skipIf(!asked)("an OpenBot this app is too old for", () => {
  const shots = process.env.OPENBOT_SHOTS_DIR;
  const states: {
    name: string;
    at: string;
    said: string;
    way: { role: "button" | "link"; name: string };
    /** The window's heading, where the state's screen is OpenBot on this computer running. */
    heading?: string;
  }[] = [
    {
      name: "connected-app-too-old",
      at: "#connect-app-too-old",
      said: "needs a newer version of this app. Update OpenBot, then connect again.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "connected-app-too-old-with-offer",
      at: "?offer#connect-app-too-old",
      said: "needs a newer version of this app. Update OpenBot, then connect again.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "connected-app-too-old-security",
      at: "#connect-app-too-old-security",
      said: "This version of OpenBot has a security problem. Update to keep using it.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-app-too-old-security",
      at: "#local-app-too-old-security",
      said: "This version of OpenBot has a security problem. Update to keep using it.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-app-too-old",
      at: "#local-app-too-old",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
      heading: "Update OpenBot",
    },
    // Found running by a launch that did not start it: the same screen as when Start finds it.
    {
      // Start refused: the release on this computer needs a newer launcher contract (launcherApi).
      name: "local-launcher-ahead",
      at: "#local-launcher-ahead",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-launcher-ahead-with-offer",
      at: "?offer#local-launcher-ahead",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-app-too-old-found-running",
      at: "?offer#local-app-too-old-running",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
      heading: "Update OpenBot",
    },
    {
      name: "existing-found-running-fails",
      at: "#local-running-fails",
      said: "Part of OpenBot needs recovery. Try starting OpenBot once more.",
      way: { role: "button", name: "Install" },
    },
    {
      name: "existing-session-ended",
      at: "#connect-session-ended",
      said: "Your sign-in to openbot.example.com has ended.",
      way: { role: "button", name: "Sign in again" },
    },
  ];
  for (const state of states) {
    for (const [width, height] of [
      [1000, 800],
      [720, 560],
    ] as const) {
      test(`${state.name} at ${width}x${height}: the sentence and its way on are in view`, async () => {
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await browser.newPage({
            viewport: { width, height },
            colorScheme,
          });
          try {
            await open(page, state.at);
            await page.getByText(state.said, { exact: false }).waitFor();
            // The card's entrance, and the update offer's first answer, settled.
            await page.waitForTimeout(1200);
            // The card's own way on: the last of its name, under the offer at the top when there is one.
            const way = await page.evaluate(({ role, name }) => {
              const found = [
                ...document.querySelectorAll(role === "link" ? "a" : "button"),
              ].filter((element) => element.textContent?.trim() === name);
              const element = found.at(-1);
              if (!element) return null;
              // A step taller than the window scrolls inside its card: there, it is reached so.
              element.scrollIntoView({ block: "nearest" });
              const box = element.getBoundingClientRect();
              const top = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return {
                y: box.top,
                bottom: box.bottom,
                covered: !(top && (top === element || element.contains(top))),
                enabled: !(element as HTMLButtonElement).disabled,
              };
            }, state.way);
            expect({ state: state.name, found: way !== null }).toEqual({
              state: state.name,
              found: true,
            });
            expect(way?.y ?? -1).toBeGreaterThanOrEqual(0);
            expect(way?.bottom ?? height + 1).toBeLessThanOrEqual(height);
            expect({ state: state.name, covered: way?.covered }).toEqual({
              state: state.name,
              covered: false,
            });
            expect(way?.enabled).toBe(true);
            // Running, so never "OpenBot is stopped" with a Start: Show OpenBot and Stop OpenBot.
            if (state.heading) {
              const screen = await page.evaluate(() => ({
                heading: document.querySelector("h1")?.textContent?.trim(),
                buttons: [...document.querySelectorAll("button")].map(
                  (button) => button.textContent?.trim(),
                ),
              }));
              expect(screen.heading).toBe(state.heading);
              expect(screen.buttons).not.toContain("Start OpenBot");
              expect(screen.buttons).toContain("Show OpenBot");
              expect(screen.buttons).toContain("Stop OpenBot");
            }
            // One Update and restart: the offer at the top stands back while the card says why.
            if (state.way.name === "Update and restart")
              expect(
                await page.evaluate(
                  () =>
                    [...document.querySelectorAll("button")].filter(
                      (button) =>
                        button.textContent?.trim() === "Update and restart",
                    ).length,
                ),
              ).toBe(1);
            const fits = await page.evaluate(() => ({
              page: document.documentElement.scrollHeight,
              window: window.innerHeight,
              wide: document.documentElement.scrollWidth,
              across: window.innerWidth,
            }));
            expect(fits.page).toBeLessThanOrEqual(fits.window);
            expect(fits.wide).toBeLessThanOrEqual(fits.across);
            if (shots && width === 1000)
              await page.screenshot({
                path: `${shots}/${state.name}-${colorScheme}.png`,
              });
          } finally {
            await page.close();
          }
        }
      }, 30_000);
    }
  }

  /*
   * On a build that never updates itself, the line that says so is part of the notice, in the
   * notice's type, on the connect screen as on the screen for the OpenBot on this computer. Seen on
   * a Mac: on the connect screen it sat under the notice in body type.
   */
  for (const state of [
    {
      name: "connected-app-too-old-internal",
      at: "?internal#connect-app-too-old",
      said: "needs a newer version of this app. Update OpenBot, then connect again.",
    },
    {
      name: "local-app-too-old-internal",
      at: "?internal#local-app-too-old",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
    },
  ]) {
    test(`${state.name}: "doesn't update itself" is in the notice, in the notice's type`, async () => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 800 },
          colorScheme,
        });
        try {
          await open(page, state.at);
          await page.getByText(state.said, { exact: false }).waitFor();
          // The update's own line (Updates, folded under the buttons, says it too).
          await page
            .locator('p[role="status"]', { hasText: "doesn't update itself" })
            .waitFor();
          await page.waitForTimeout(1200);
          const placed = await page.evaluate((said) => {
            const notice = [...document.querySelectorAll(".local-alert")].find(
              (element) => element.textContent?.includes(said),
            );
            const sentence = [...(notice?.querySelectorAll("p") ?? [])].find(
              (element) => element.textContent?.includes(said),
            );
            const line = [
              ...document.querySelectorAll('p[role="status"]'),
            ].find((element) =>
              element.textContent?.includes("doesn't update itself"),
            );
            const size = (element: Element | undefined) =>
              element ? getComputedStyle(element).fontSize : null;
            return {
              inside: Boolean(notice && line && notice.contains(line)),
              line: size(line),
              notice: size(sentence),
              updates: [...document.querySelectorAll("button")].filter(
                (button) => button.textContent?.trim() === "Update and restart",
              ).length,
            };
          }, state.said);
          expect(placed.notice).not.toBeNull();
          expect(placed).toEqual({
            inside: true,
            line: placed.notice,
            notice: placed.notice,
            updates: 0,
          });
          if (shots)
            await page.screenshot({
              path: `${shots}/${state.name}-${colorScheme}.png`,
            });
        } finally {
          await page.close();
        }
      }
    }, 30_000);
  }
});

/*
 * After Stop, the Status window's App row said Stopped and offered nothing, while the services row
 * under it offered Start. The App row offers Start now, laid out as the services row's: the same
 * button, as far under its heading, at the same left edge. In the window's own size, light and dark.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of the window, stopped and running.
 */
describe.skipIf(!asked)("the Status window after Stop", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`the App row offers Start as the services row does (${colorScheme})`, async () => {
      const shots = process.env.OPENBOT_APP_SHOTS;
      const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
      for (const state of ["running", "stopped"] as const) {
        const page = await browser.newPage({
          viewport: { width: 640, height: 720 },
          colorScheme,
        });
        try {
          await open(page, state === "stopped" ? "?stopped#status" : "#status");
          await page.getByRole("region", { name: "App" }).waitFor();
          await page.waitForTimeout(400);
          if (shots)
            await page.screenshot({
              path: `${shots}/status-${state}-${colorScheme}-${engine}.png`,
            });
          if (state === "running") continue;
          const seen = await page.evaluate(() => {
            const part = (name: string) => {
              const section = document.querySelector(
                `section[aria-label="${name}"]`,
              );
              const head = section?.querySelector(".status-head");
              const buttons = [...(section?.querySelectorAll("button") ?? [])];
              const button = buttons[0]?.getBoundingClientRect();
              const top = head?.getBoundingClientRect();
              // Whole pixels: Chromium on Linux lays a 40 px button out at 39.99998.
              const px = (value: number | undefined) =>
                value === undefined ? null : Math.round(value);
              return {
                said: buttons.map((one) => one.textContent),
                left: px(button?.left),
                width: px(button?.width),
                height: px(button?.height),
                underHead:
                  button && top ? Math.round(button.top - top.bottom) : null,
                className: buttons[0]?.className,
              };
            };
            return { app: part("App"), services: part("OpenBot's services") };
          });
          expect(seen.app.said).toEqual(["Start"]);
          expect(seen.services.said).toEqual(["Start"]);
          expect(seen.app.className).toBe(seen.services.className);
          expect(seen.app.left).toBe(seen.services.left);
          expect(seen.app.width).toBe(seen.services.width);
          expect(seen.app.height).toBe(seen.services.height);
          expect(seen.app.underHead).toBe(seen.services.underHead);
        } finally {
          await page.close();
        }
      }
    }, 30_000);
});

/*
 * Two states the Mac and Windows pass found. Opened while OpenBot updated itself, the App row said
 * Stopped and offered Start: it says Updating now, with nothing to press. And after the App row's
 * Start brought everything up in the main window, the services row still said Stopped, with Start,
 * until Refresh: told the Start finished (`status:refresh`), it reads its readiness again. Each
 * screenshot is taken before anything is asserted, so a run against the earlier window keeps its
 * look too. `OPENBOT_APP_SHOTS=<folder>` keeps them, light and dark.
 */
describe.skipIf(!asked)(
  "the Status window through an update and a start",
  () => {
    const shots = process.env.OPENBOT_APP_SHOTS;
    const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
    const shoot = (page: Page, name: string, colorScheme: string) =>
      shots
        ? page.screenshot({
            path: `${shots}/status-${name}-${colorScheme}-${engine}.png`,
          })
        : null;
    const appRow = (page: Page) =>
      page.evaluate(() => {
        const section = document.querySelector('section[aria-label="App"]');
        return {
          state: section?.querySelector(".status-state")?.textContent ?? null,
          buttons: [...(section?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
          ),
        };
      });
    const servicesRow = (page: Page) =>
      page.evaluate(() => {
        const section = document.querySelector(
          `section[aria-label="OpenBot's services"]`,
        );
        return {
          state: section?.querySelector(".status-state")?.textContent ?? null,
          buttons: [...(section?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
          ),
        };
      });

    for (const colorScheme of ["light", "dark"] as const) {
      test(`while OpenBot updates, the App row says Updating and nothing offers Start (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 640, height: 720 },
          colorScheme,
        });
        try {
          await open(page, "?updating#status");
          await page.getByRole("region", { name: "App" }).waitFor();
          await page.waitForTimeout(400);
          await shoot(page, "updating", colorScheme);
          expect(await appRow(page)).toEqual({
            state: "Updating",
            buttons: [],
          });
          // Nor the services row: the update starts what it needs.
          expect(await servicesRow(page)).toEqual({
            state: "Stopped",
            buttons: [],
          });
        } finally {
          await page.close();
        }
      }, 30_000);

      test(`once a start finishes, the services row follows without Refresh (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 640, height: 720 },
          colorScheme,
        });
        try {
          await open(page, "?started#status");
          await page.getByRole("region", { name: "App" }).waitFor();
          await page.waitForTimeout(400);
          // The main window's Start brings everything up; the window's own reading sees the parts.
          await page.evaluate(() => {
            (globalThis as unknown as { __fake: { up: boolean } }).__fake.up =
              true;
          });
          await page
            .locator('section[aria-label="App"] .status-state', {
              hasText: "Running",
            })
            .waitFor();
          await page.waitForTimeout(400);
          // Told the Start finished, as the native side tells it.
          await page.evaluate(() =>
            (
              globalThis as unknown as {
                __fake: { emit: (name: string, payload: unknown) => void };
              }
            ).__fake.emit("status:refresh", null),
          );
          await page.waitForTimeout(1500);
          await shoot(page, "started", colorScheme);
          expect((await appRow(page)).buttons).toEqual(["Restart", "Stop"]);
          expect(await servicesRow(page)).toEqual({
            state: "Ready · 2.4 GB",
            buttons: ["Restart", "Stop"],
          });
        } finally {
          await page.close();
        }
      }, 40_000);
    }
  },
);

/*
 * The move to OpenBot Cloud, each of its screens in the first screen's card, at the window's
 * default size (1000x800, tauri.conf.json), that less a title bar (1000x760), and its smallest
 * (720x560). The page never scrolls, and every one of a screen's buttons is whole in the window and
 * in the card's view, not under anything, as the screen opens. At 1000x760 every common case fits
 * with nothing scrolled inside the card; what is taller scrolls inside the card above its buttons.
 *
 * Seen on 1.2.0-rc.2: a move that failed showed its technical details, the screen ran past the
 * card's foot, and Try again and Keep OpenBot on this computer were out of view. The person quit
 * and reopened OpenBot to get past it. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each,
 * light and dark, taken before anything is asserted.
 */
describe.skipIf(!asked)(
  "the move to OpenBot Cloud at the window's size",
  () => {
    const shots = process.env.OPENBOT_APP_SHOTS;
    const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
    const SIZES = [
      [1000, 760],
      [1000, 800],
      [720, 560],
    ] as const;
    const SCREENS: {
      hash: string;
      /** The test's and the screenshot's name, when one hash shows two ways. */
      name?: string;
      heading: string;
      /** Pressed on the confirm screen, once what moves has loaded. */
      move?: boolean;
      /** Technical details opened, as the person would. */
      openDetail?: boolean;
      /** Scrolls inside the card at 1000x760. */
      scrolls?: boolean;
      /** Nothing to press: sending, past signing in, has no Cancel. */
      noButtons?: boolean;
    }[] = [
      { hash: "#move-choice", heading: "Move to OpenBot Cloud?" },
      { hash: "#move-confirm", heading: "Move to OpenBot Cloud" },
      { hash: "#move-confirm-loading", heading: "Move to OpenBot Cloud" },
      {
        hash: "#move-confirm-many",
        heading: "Move to OpenBot Cloud",
        scrolls: true,
      },
      { hash: "#move-signin", heading: "Moving to OpenBot Cloud", move: true },
      {
        hash: "#move-midway",
        heading: "Moving to OpenBot Cloud",
        move: true,
        noButtons: true,
      },
      { hash: "#move-failed", heading: "The move didn't finish", move: true },
      // In more than one organization on OpenBot Cloud: where the Bots go, one of them held.
      {
        hash: "#move-where",
        heading: "Where should your Bots go?",
        move: true,
      },
      {
        hash: "#move-not-allowed",
        heading: "Your Bots can't move there",
        move: true,
      },
      {
        hash: "#move-failed-detail",
        heading: "The move didn't finish",
        move: true,
        scrolls: true,
      },
      {
        hash: "#move-failed-detail",
        name: "move-failed-detail-open",
        heading: "The move didn't finish",
        move: true,
        openDetail: true,
        scrolls: true,
      },
      // OpenBot Cloud's own three-line sentence: a few pixels past the card, the buttons in view.
      {
        hash: "#move-stopped",
        heading: "The move didn't finish",
        move: true,
        scrolls: true,
      },
      { hash: "#move-done", heading: "You're on OpenBot Cloud", move: true },
      {
        hash: "#move-done-held",
        heading: "You're on OpenBot Cloud",
        move: true,
      },
      {
        hash: "#move-done-left",
        heading: "You're on OpenBot Cloud",
        move: true,
      },
      { hash: "#move-done-ai", heading: "You're on OpenBot Cloud", move: true },
      // Apps connected with a key come across connected, apart from those signed in to again: two
      // lists, which scroll inside the card above its buttons, as many apps do.
      {
        hash: "#move-confirm-carried",
        heading: "Move to OpenBot Cloud",
        scrolls: true,
      },
      {
        hash: "#move-done-carried",
        heading: "You're on OpenBot Cloud",
        move: true,
        scrolls: true,
      },
      {
        hash: "#move-done-ai-carried",
        heading: "You're on OpenBot Cloud",
        move: true,
        scrolls: true,
      },
    ];
    /*
     * The move screen's choices: OpenBot Cloud, then OpenBot for Business as the first screen draws
     * it, then OpenBot (Self-Contained), one above the other at one width. Business's four clouds
     * are drawn, on one line, inside its row past its words.
     */
    const MOVE_CHOICE_ROWS = {
      names: [
        "OpenBot Cloud Recommended",
        "OpenBot for Business",
        "OpenBot (Self-Contained)",
      ],
      stacked: true,
      drawn: [
        ["aws", true],
        ["azure", true],
        ["google-cloud", true],
        ["kubernetes", true],
      ],
      marks: true,
    };
    const moveChoiceRows = async (page: Page) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      return page.evaluate(() => {
        const rows = [
          ...document.querySelectorAll("fieldset.picker.hosting > .tile"),
        ];
        const boxes = rows.map((row) => row.getBoundingClientRect());
        const business = document.querySelector(
          "fieldset.picker.hosting > .tile.with-marks",
        );
        const box = business?.getBoundingClientRect();
        const words = business
          ?.querySelector(".tile-summary")
          ?.getBoundingClientRect();
        const marks = [
          ...(business?.querySelectorAll(".cloud-mark") ?? []),
        ].map((mark) => mark.getBoundingClientRect());
        return {
          names: rows.map(
            (row) => row.querySelector(".tile-name")?.textContent ?? "",
          ),
          stacked: boxes.every(
            (row, at) =>
              row.width === boxes[0]?.width &&
              (at === 0 || row.top >= (boxes[at - 1]?.bottom ?? 0)),
          ),
          drawn: [
            ...(business?.querySelectorAll<HTMLImageElement>(
              ".cloud-mark img",
            ) ?? []),
          ].map((image) => [
            image.dataset.mark,
            image.complete && image.naturalWidth > 0,
          ]),
          marks:
            marks.length === 4 &&
            !!box &&
            !!words &&
            marks.every(
              (mark) =>
                mark.top >= box.top &&
                mark.bottom <= box.bottom &&
                mark.right <= box.right &&
                mark.left >= words.right &&
                mark.top === marks[0]?.top,
            ),
        };
      });
    };
    for (const [width, height] of SIZES)
      for (const colorScheme of ["light", "dark"] as const) {
        for (const screen of SCREENS) {
          const name = screen.name ?? screen.hash.slice(1);
          test(`at ${width}x${height}, ${name} fits the window, its buttons in view (${colorScheme})`, async () => {
            const page = await browser.newPage({
              viewport: { width, height },
              colorScheme,
            });
            try {
              await open(page, screen.hash, cloudBuilt);
              if (screen.move) {
                await page.getByRole("list", { name: "What moves" }).waitFor();
                await page
                  .getByRole("button", { name: "Move to OpenBot Cloud" })
                  .click();
              }
              await page
                .getByRole("heading", { name: screen.heading, exact: true })
                .waitFor();
              if (
                screen.hash === "#move-confirm" ||
                screen.hash === "#move-confirm-carried"
              )
                await page.getByRole("list", { name: "What moves" }).waitFor();
              if (screen.openDetail) {
                await page
                  .getByText("Technical details", { exact: true })
                  .click();
                await page.waitForTimeout(100);
                // Opened, they show: whole, in the card's view, clear of its pinned foot.
                const shown = await page.evaluate(() => {
                  const sheet = document.querySelector("main > .sheet");
                  const said = document.querySelector("main details pre");
                  const foot = document.querySelector(
                    "main > .sheet > .step-footer",
                  );
                  const box = said?.getBoundingClientRect();
                  return {
                    top: box?.top ?? 0,
                    bottom: box?.bottom ?? 0,
                    ceiling: sheet?.getBoundingClientRect().top ?? 0,
                    floor: Math.min(
                      foot?.getBoundingClientRect().top ??
                        Number.POSITIVE_INFINITY,
                      sheet?.getBoundingClientRect().bottom ?? 0,
                    ),
                  };
                });
                expect(shown.bottom).toBeGreaterThan(shown.top);
                expect(shown.top).toBeGreaterThanOrEqual(shown.ceiling);
                // Within the pixel the card's scroll snaps to.
                expect(shown.bottom).toBeLessThanOrEqual(shown.floor + 1);
              }
              // The card's entrance over, and the pointer off whatever it pressed.
              await page.mouse.move(0, 0);
              await page.waitForTimeout(600);
              if (shots)
                await page.screenshot({
                  path: `${shots}/${name}-${width}x${height}-${colorScheme}-${engine}.png`,
                });
              // What scrolls inside the card, scrolled to its end for a look, then back.
              if (shots && screen.scrolls) {
                await page.evaluate(() => {
                  const sheet = document.querySelector("main > .sheet");
                  if (sheet) sheet.scrollTop = sheet.scrollHeight;
                });
                await page.waitForTimeout(200);
                await page.screenshot({
                  path: `${shots}/${name}-scrolled-${width}x${height}-${colorScheme}-${engine}.png`,
                });
                await page.evaluate(() => {
                  const sheet = document.querySelector("main > .sheet");
                  if (sheet) sheet.scrollTop = 0;
                });
              }
              const fit = await page.evaluate(() => {
                const sheet = document.querySelector("main > .sheet");
                const card = sheet?.getBoundingClientRect();
                const style = sheet ? getComputedStyle(sheet) : null;
                // The card's view: inside its border, and inside the window.
                const top = Math.max(
                  0,
                  (card?.top ?? 0) +
                    (Number.parseFloat(style?.borderTopWidth ?? "") || 0),
                );
                const bottom = Math.min(
                  window.innerHeight,
                  (card?.bottom ?? 0) -
                    (Number.parseFloat(style?.borderBottomWidth ?? "") || 0),
                );
                // The screen's own buttons, not those in a list inside it.
                const buttons = [
                  ...document.querySelectorAll(
                    "main > .sheet > .row button, main > .sheet > .step-footer button",
                  ),
                ];
                return {
                  cardScrolls: sheet
                    ? sheet.scrollHeight > sheet.clientHeight + 1
                    : true,
                  pageScrolls:
                    document.documentElement.scrollHeight >
                      window.innerHeight ||
                    document.documentElement.scrollWidth > window.innerWidth,
                  buttons: buttons.length,
                  outOfView: buttons
                    .filter((button) => {
                      const box = button.getBoundingClientRect();
                      const hit = document.elementFromPoint(
                        box.left + box.width / 2,
                        box.top + box.height / 2,
                      );
                      return !(
                        box.top >= top &&
                        box.bottom <= bottom &&
                        box.left >= 0 &&
                        box.right <= window.innerWidth &&
                        hit !== null &&
                        button.contains(hit)
                      );
                    })
                    .map((button) => button.textContent),
                };
              });
              if (screen.noButtons) expect(fit.buttons).toBe(0);
              else expect(fit.buttons).toBeGreaterThan(0);
              expect({
                pageScrolls: fit.pageScrolls,
                outOfView: fit.outOfView,
              }).toEqual({ pageScrolls: false, outOfView: [] });
              if (height === 760)
                expect(fit.cardScrolls).toBe(screen.scrolls === true);
              // The result says the figure the move screens said, counted the same way.
              const said = await page.evaluate(
                () => document.querySelector("main")?.textContent ?? "",
              );
              if (screen.hash === "#move-choice") {
                expect(said).toContain(
                  "This removes about 20.2 GB of OpenBot files from this computer.",
                );
                expect(await moveChoiceRows(page)).toEqual(MOVE_CHOICE_ROWS);
              }
              if (screen.hash === "#move-confirm")
                expect(said).toContain(
                  "Removes about 20.2 GB of OpenBot files.",
                );
              if (screen.hash.startsWith("#move-done"))
                expect(said).toContain("20.2 GB of OpenBot files removed");
              // Their own organization first and picked, then the others; one held, saying why.
              if (screen.hash === "#move-where")
                expect(
                  await page.evaluate(() =>
                    [
                      ...document.querySelectorAll<HTMLInputElement>(
                        "fieldset.picker > .tile > .tile-input",
                      ),
                    ].map((input) => [
                      input.closest(".tile")?.querySelector(".tile-name")
                        ?.textContent,
                      input.checked,
                      input.disabled,
                      input.closest(".tile")?.querySelector(".tile-summary")
                        ?.textContent,
                    ]),
                  ),
                ).toEqual([
                  ["Sam's organization", true, false, "Your own organization."],
                  [
                    "Northwind Traders",
                    false,
                    false,
                    "An organization you belong to.",
                  ],
                  [
                    "Research Lab",
                    false,
                    true,
                    "An admin of this organization hasn't let you use Bots here.",
                  ],
                ]);
              if (screen.hash === "#move-not-allowed")
                expect(said).toContain(
                  "Nothing was removed from this computer.",
                );
              expect(said.includes("of that is free space on your disk")).toBe(
                screen.hash === "#move-done-held",
              );
              // Still needing an AI: Connect your AI leads, and no Reconnect skips it.
              if (screen.hash === "#move-done-ai") {
                expect(said).toContain("Connect your AI first");
                expect(said).toContain("Then reconnect your apps");
                const buttons = await page.evaluate(() =>
                  [...document.querySelectorAll("main button")].map(
                    (button) => button.textContent,
                  ),
                );
                expect(buttons).toEqual(["Connect your AI"]);
              }
            } finally {
              await page.close();
            }
          }, 30_000);
        }
      }

    // Keep, pressed where it shows with nothing scrolled first, leaves the move for OpenBot here.
    for (const [width, height] of [
      [1000, 800],
      [720, 560],
    ] as const)
      test(`at ${width}x${height}, Keep on a failed move with its technical details open opens OpenBot here`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page, "#move-failed-detail", cloudBuilt);
          await page.getByRole("list", { name: "What moves" }).waitFor();
          await page
            .getByRole("button", { name: "Move to OpenBot Cloud" })
            .click();
          await page
            .getByRole("heading", {
              name: "The move didn't finish",
              exact: true,
            })
            .waitFor();
          await page.getByText("Technical details", { exact: true }).click();
          await page.evaluate(() => {
            const sheet = document.querySelector("main > .sheet");
            if (sheet) sheet.scrollTop = 0;
          });
          await page.waitForTimeout(600);
          const keep = await page
            .getByRole("button", { name: "Keep OpenBot on this computer" })
            .boundingBox();
          expect(keep).not.toBeNull();
          if (!keep) return;
          expect(keep.y + keep.height).toBeLessThanOrEqual(height);
          // The mouse, not a locator's click, which would scroll the button into view first.
          await page.mouse.click(
            keep.x + keep.width / 2,
            keep.y + keep.height / 2,
          );
          for (let i = 0; i < 50; i += 1) {
            if ((await calls(page)).includes("show_openbot")) break;
            await page.waitForTimeout(100);
          }
          const made = await calls(page);
          expect(made).toContain("keep_self_contained");
          expect(made).toContain("show_openbot");
          expect(made.indexOf("show_openbot")).toBeGreaterThan(
            made.indexOf("keep_self_contained"),
          );
          await page
            .getByRole("heading", {
              name: "The move didn't finish",
              exact: true,
            })
            .waitFor({ state: "hidden" });
        } finally {
          await page.close();
        }
      }, 30_000);

    /*
     * OpenBot for Business, picked on the move screen: the first screen's booker under the rows,
     * Book a demo in view at once, and nothing that moves or keeps. Taller than the window, it
     * scrolls in the card as it does on the first screen; the page never does, and nothing runs off
     * the card's side. OpenBot Cloud again brings back Continue and its promise, fitting as before.
     */
    for (const [width, height] of [
      [1000, 760],
      [720, 560],
    ] as const)
      for (const colorScheme of ["light", "dark"] as const)
        test(`at ${width}x${height}, OpenBot for Business on the move screen books a demo in the card and moves nothing (${colorScheme})`, async () => {
          const page = await browser.newPage({
            viewport: { width, height },
            colorScheme,
          });
          try {
            await routeCalendar(page);
            await open(page, "#move-choice", cloudBuilt);
            await page
              .getByRole("heading", {
                name: "Move to OpenBot Cloud?",
                exact: true,
              })
              .waitFor();
            await page
              .getByText("Your own cloud or on-prem. Book a demo.")
              .click();
            await page
              .locator(
                '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
              )
              .waitFor();
            await page.mouse.move(0, 0);
            await page.waitForTimeout(600);
            if (shots)
              await page.screenshot({
                path: `${shots}/move-choice-business-${width}x${height}-${colorScheme}-${engine}.png`,
              });
            expect(await moveChoiceRows(page)).toEqual(MOVE_CHOICE_ROWS);
            const shape = await page.evaluate(() => {
              const card = document.querySelector(
                "main > .sheet",
              ) as HTMLElement;
              const view = card.getBoundingClientRect();
              const rows = [
                ...document.querySelectorAll("fieldset.picker.hosting > .tile"),
              ];
              const last = rows[rows.length - 1]?.getBoundingClientRect();
              const booker = document
                .querySelector(".business-booker")
                ?.getBoundingClientRect();
              const book = [...document.querySelectorAll("button")]
                .find((button) => button.textContent === "Book a demo")
                ?.getBoundingClientRect();
              const wider = [...card.querySelectorAll("*")].filter(
                (element) =>
                  element.getBoundingClientRect().right > view.right + 0.5,
              );
              return {
                page:
                  document.documentElement.scrollHeight <= window.innerHeight &&
                  document.documentElement.scrollWidth <= window.innerWidth,
                cardScrolls: card.scrollHeight > card.clientHeight + 1,
                sideways: card.scrollWidth - card.clientWidth <= 0,
                wider: wider.map((element) => element.className),
                chosen: document.querySelector(".tile.chosen .tile-name")
                  ?.textContent,
                underRows: !!booker && !!last && booker.top >= last.bottom,
                // Its first line shows under the rows without a scroll, at every size.
                bookerShows: !!booker && booker.top + 24 <= view.bottom,
                bookInView:
                  !!book && book.top >= view.top && book.bottom <= view.bottom,
                // The screen's own buttons: none moves and none keeps.
                own: [
                  ...document.querySelectorAll(
                    "main > .sheet > .row button, main > .sheet > .step-footer button",
                  ),
                ].map((button) => button.textContent),
                footnote: document.querySelector("main > .sheet > .footnote")
                  ?.textContent,
              };
            });
            const { bookInView, ...laid } = shape;
            expect(laid).toEqual({
              page: true,
              cardScrolls: true,
              sideways: true,
              wider: [],
              chosen: "OpenBot for Business",
              underRows: true,
              bookerShows: true,
              own: [],
              footnote: undefined,
            });
            // At the window's default size Book a demo is in view at once; in the smallest window
            // the card scrolls to it, as it does to anything below the rows.
            if (height === 760) expect(bookInView).toBe(true);
            const scrolled = await page.evaluate(() => {
              const card = document.querySelector(
                "main > .sheet",
              ) as HTMLElement;
              const button = [...document.querySelectorAll("button")].find(
                (each) => each.textContent === "Book a demo",
              );
              button?.scrollIntoView({ block: "nearest" });
              const view = card.getBoundingClientRect();
              const box = button?.getBoundingClientRect();
              return (
                !!box &&
                box.top >= view.top &&
                box.bottom <= Math.min(window.innerHeight, view.bottom)
              );
            });
            expect(scrolled).toBe(true);
            const made = await calls(page);
            expect(made).not.toContain("move_preview");
            expect(made).not.toContain("move_to_cloud");
            expect(made).not.toContain("keep_self_contained");
            // OpenBot Cloud again: Continue and the promise, in view, the calendar gone.
            await page.getByText(/move to your OpenBot Cloud account/).click();
            await page
              .getByRole("button", { name: "Continue", exact: true })
              .waitFor();
            await page.mouse.move(0, 0);
            await page.waitForTimeout(300);
            const back = await page.evaluate(() => {
              const card = document.querySelector(
                "main > .sheet",
              ) as HTMLElement;
              const view = card.getBoundingClientRect();
              const go = [...document.querySelectorAll("button")]
                .find((button) => button.textContent === "Continue")
                ?.getBoundingClientRect();
              return {
                calendar: document.querySelectorAll(
                  'iframe[title="Booking calendar"]',
                ).length,
                continueInView:
                  !!go &&
                  go.top >= Math.max(0, view.top) &&
                  go.bottom <= Math.min(window.innerHeight, view.bottom),
                footnote: document.querySelector("main > .sheet > .footnote")
                  ?.textContent,
              };
            });
            expect(back).toEqual({
              calendar: 0,
              continueInView: true,
              footnote:
                "Nothing is removed from this computer until everything has arrived in OpenBot Cloud and been checked.",
            });
          } finally {
            await page.close();
          }
        }, 30_000);
  },
);

/** The commands that start or update OpenBot or its backend on this computer. */
const STARTS_OR_UPDATES = [
  "wake_engine",
  "run_local_eval",
  "set_up_local_eval",
  "connect_local_eval",
  "upgrade_and_start",
  "start_stack",
];

/** The native commands the window has asked for, in order. */
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __fake: { calls: string[] } }).__fake.calls,
  );

/** Every heading the window shows from now on, kept as it shows. */
const watchHeadings = (page: Page) =>
  page.evaluate(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __headings: string[] }).__headings = seen;
    const note = () => {
      const heading = document.querySelector("main h1")?.textContent ?? "";
      if (heading && seen[seen.length - 1] !== heading) seen.push(heading);
    };
    note();
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

const headingsSeen = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { __headings: string[] }).__headings,
  );

/*
 * A dogfooding report on 1.2.0-rc.1: installed over OpenBot (Self-Contained) on a Mac, the window
 * showed "Updating OpenBot" for about three minutes, and only then asked "Move to
 * OpenBot Cloud?". OpenBot Cloud is the default, so the question comes first now, before anything
 * starts or updates. Picking OpenBot Cloud updates and starts OpenBot under the move's own screen,
 * which fills in what moves once it can read it; Keep runs the update as it always has. In
 * Chromium, and with `OPENBOT_APP_ENGINE=webkit` in the engine the Mac window draws with.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each screen.
 */
describe.skipIf(!asked)(
  "the move to OpenBot Cloud, due at a relaunch that would update OpenBot",
  () => {
    const shots = process.env.OPENBOT_APP_SHOTS;
    const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
    const shoot = async (page: Page, name: string) => {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(500);
      if (shots)
        await page.screenshot({
          path: `${shots}/move-first-${name}-${engine}.png`,
        });
    };

    test("OpenBot Cloud: asked before any update, then no Self-Contained update screen, and the move completes", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
      });
      try {
        await open(page, "#move-first", cloudBuilt);
        await page
          .getByRole("heading", { name: "Move to OpenBot Cloud?", exact: true })
          .waitFor();
        await watchHeadings(page);
        await shoot(page, "choice");
        // Nothing started or updated before the question.
        expect(
          (await calls(page)).filter((call) =>
            STARTS_OR_UPDATES.includes(call),
          ),
        ).toEqual([]);

        await page.getByRole("button", { name: "Continue" }).click();
        await page
          .getByText(
            "Getting your Bots ready to move. This can take a few minutes.",
          )
          .waitFor();
        // OpenBot updates behind the move's screen.
        for (let i = 0; i < 50; i += 1) {
          if ((await calls(page)).includes("upgrade_and_start")) break;
          await page.waitForTimeout(100);
        }
        expect(await calls(page)).toContain("upgrade_and_start");
        await shoot(page, "getting-ready");
        expect(
          await page.evaluate(
            () => document.querySelector("main h1")?.textContent,
          ),
        ).toBe("Move to OpenBot Cloud");

        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishUpdate: () => void } }
          ).__fake.finishUpdate(),
        );
        await page.getByRole("list", { name: "What moves" }).waitFor();
        await shoot(page, "confirm");
        await page
          .getByRole("button", { name: "Move to OpenBot Cloud" })
          .click();
        await page
          .getByRole("heading", { name: "You're on OpenBot Cloud" })
          .waitFor();
        await shoot(page, "done");

        const made = await calls(page);
        expect(made).toContain("move_preview");
        expect(made).toContain("move_to_cloud");
        expect(made).not.toContain("show_openbot");
        expect(made).not.toContain("keep_self_contained");
        // What moves was read only once OpenBot was up.
        expect(made.indexOf("move_preview")).toBeGreaterThan(
          made.indexOf("upgrade_and_start"),
        );
        const headings = await headingsSeen(page);
        expect(headings).not.toContain("Updating OpenBot");
        expect(headings).not.toContain("Starting OpenBot");
        // Only the move's own screens, from the question to the end.
        expect(
          headings.filter(
            (heading) =>
              ![
                "Move to OpenBot Cloud?",
                "Move to OpenBot Cloud",
                "Moving to OpenBot Cloud",
                "You're on OpenBot Cloud",
              ].includes(heading),
          ),
        ).toEqual([]);
      } finally {
        await page.close();
      }
    }, 40_000);

    /*
     * FOUND IN A MAC UPGRADE CHECK of 1.2: the choice said the move removes about 23.1 GB and the
     * next screen 26.6 GB, measured after the update added the new release's files. The choice says
     * no figure while the update is still to come, and the next screen says the updated one only.
     */
    for (const colorScheme of ["light", "dark"] as const)
      test(`one size for what the move removes, from the updated OpenBot (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 760 },
          colorScheme,
        });
        const sized = async (name: string) => {
          await page.mouse.move(0, 0);
          await page.waitForTimeout(500);
          if (shots)
            await page.screenshot({
              path: `${shots}/move-first-size-${name}-${colorScheme}-${engine}.png`,
            });
          return page.evaluate(() => document.body.innerText);
        };
        try {
          await open(page, "#move-first", cloudBuilt);
          await page
            .getByRole("heading", {
              name: "Move to OpenBot Cloud?",
              exact: true,
            })
            .waitFor();
          const choice = await sized("choice");
          await page.getByRole("button", { name: "Continue" }).click();
          await page
            .getByText(
              "Getting your Bots ready to move. This can take a few minutes.",
            )
            .waitFor();
          const ready = await sized("getting-ready");
          await page.evaluate(() =>
            (
              globalThis as unknown as {
                __fake: { finishUpdate: () => void };
              }
            ).__fake.finishUpdate(),
          );
          await page.getByRole("list", { name: "What moves" }).waitFor();
          const confirm = await sized("confirm");
          expect(choice).toContain("move to your OpenBot Cloud account.");
          expect(choice).not.toContain("GB");
          expect(ready).not.toContain("GB");
          expect(confirm).toContain("Removes about 26.6 GB of OpenBot files.");
          expect(confirm).not.toContain("23.1 GB");
        } finally {
          await page.close();
        }
      }, 40_000);

    test("Keep: asked before any update, then the update runs as before and OpenBot opens", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
      });
      try {
        await open(page, "#move-first", cloudBuilt);
        await page
          .getByRole("heading", { name: "Move to OpenBot Cloud?", exact: true })
          .waitFor();
        expect(
          (await calls(page)).filter((call) =>
            STARTS_OR_UPDATES.includes(call),
          ),
        ).toEqual([]);
        await page
          .getByText("Everything stays on this computer, as it is now.")
          .click();
        await shoot(page, "keep-picked");
        await page
          .getByRole("button", { name: "Keep OpenBot on this computer" })
          .click();
        await page.getByRole("heading", { name: "Updating OpenBot" }).waitFor();
        await shoot(page, "keep-updating");
        const made = await calls(page);
        expect(made.indexOf("keep_self_contained")).toBeGreaterThan(-1);
        expect(made.indexOf("upgrade_and_start")).toBeGreaterThan(
          made.indexOf("keep_self_contained"),
        );

        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishUpdate: () => void } }
          ).__fake.finishUpdate(),
        );
        for (let i = 0; i < 50; i += 1) {
          if ((await calls(page)).includes("show_openbot")) break;
          await page.waitForTimeout(100);
        }
        const after = await calls(page);
        expect(after).toContain("show_openbot");
        expect(after).not.toContain("move_preview");
      } finally {
        await page.close();
      }
    }, 40_000);
  },
);

/*
 * FOUND ON 1.2.0-rc.3, a Mac, after an update: the setup window stayed a plain ground with nothing
 * on it, across two launches, while its page's code still ran. A screen that failed to draw took
 * every screen with it, leaving only the ground behind them. Now it shows "OpenBot hit a problem"
 * on the setup window's own failure box, with Reload and the logs, readable in light and dark.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each.
 */
describe.skipIf(!asked)("a screen that fails to draw", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`shows OpenBot hit a problem, never the bare ground (${colorScheme})`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        colorScheme,
      });
      try {
        await open(page, "?throws");
        await page
          .getByRole("heading", { name: "OpenBot hit a problem" })
          .waitFor();
        await page.waitForTimeout(300);
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/page-problem-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
          });
        const seen = await page.evaluate(() => {
          const shown = (selector: string) => {
            const element = document.querySelector(selector);
            const rect = element?.getBoundingClientRect();
            const style = element ? getComputedStyle(element) : null;
            return Boolean(
              rect &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.bottom <= window.innerHeight &&
                style?.visibility !== "hidden" &&
                style?.color !== style?.backgroundColor,
            );
          };
          const buttons = [...document.querySelectorAll("main button")].map(
            (button) => button.textContent,
          );
          return {
            // What a person reads, as the browser lays it out: not the bare ground.
            text: (document.getElementById("root") as HTMLElement).innerText,
            sheet: shown("main .sheet"),
            heading: shown("main h1"),
            box: shown("main .blocker"),
            buttons,
          };
        });
        expect(seen.text).toContain("OpenBot hit a problem");
        expect(seen.text).toContain(
          "This window stopped working. Reload it to carry on.",
        );
        expect(seen.sheet).toBe(true);
        expect(seen.heading).toBe(true);
        expect(seen.box).toBe(true);
        expect(seen.buttons).toEqual(["Reload", "Copy logs", "Save to a file"]);
        // The error reached the shell, for the Desktop log.
        expect(await calls(page)).toContain("page_error");
      } finally {
        await page.close();
      }
    });
});

/** Approved account study: fixed heading, centered interaction and a top-safe scroll body. */
describe.skipIf(!asked)("approved layout: account", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`${width}x${height} ${colorScheme}: checking, code, engine wait and recovery remain reachable`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const shot = async (state: string) => {
          await settled(page);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/account-${state}-${width}x${height}-${colorScheme}.png`,
            });
        };
        const geometry = () =>
          page.evaluate(() => {
            const sheet =
              document.querySelector<HTMLElement>(".account-layout")!;
            const header = sheet
              .querySelector<HTMLElement>(".setup-header-block")!
              .getBoundingClientRect();
            const title = sheet
              .querySelector<HTMLElement>("h1")!
              .getBoundingClientRect();
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const content = sheet
              .querySelector<HTMLElement>(".setup-content")!
              .getBoundingClientRect();
            const box = body.getBoundingClientRect();
            const rail = document
              .querySelector<HTMLElement>(".rail-title")!
              .getBoundingClientRect();
            return {
              titleY: title.y,
              railY: rail.y,
              headerBottom: header.bottom,
              bodyTop: box.top,
              bodyBottom: box.bottom,
              bodyHeight: box.height,
              contentTop: content.top,
              contentBottom: content.bottom,
              contentHeight: content.height,
              centerOffset:
                (content.top + content.bottom - box.top - box.bottom) / 2,
              contentWidth: content.width,
              bodyScroll: body.scrollHeight,
              bodyClient: body.clientHeight,
              pageHeight: document.documentElement.scrollHeight,
              pageWidth: document.documentElement.scrollWidth,
              horizontalOverflow: [
                ...sheet.querySelectorAll<HTMLElement>(
                  ".setup-body, .setup-content, .setup-panel, .sign-in-wait, .sign-in-code-row",
                ),
              ].some(
                (element) => element.scrollWidth > element.clientWidth + 1,
              ),
            };
          });
        // Scroll through the real body and check each action's center is unobstructed and focusable.
        const reachable = async (selector: string) => {
          const action = await page.evaluate((selector) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            element.scrollIntoView({ block: "nearest" });
            element.focus();
            const box = element.getBoundingClientRect();
            const body = element
              .closest(".setup-body")!
              .getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            return {
              focused: document.activeElement === element,
              hit: element === hit || element.contains(hit),
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              right: box.right,
              bodyTop: body.top,
              bodyBottom: body.bottom,
            };
          }, selector);
          expect(action.focused).toBe(true);
          expect(action.hit).toBe(true);
          expect(action.top).toBeGreaterThanOrEqual(action.bodyTop - 1);
          expect(action.bottom).toBeLessThanOrEqual(action.bodyBottom + 1);
          expect(action.left).toBeGreaterThanOrEqual(0);
          expect(action.right).toBeLessThanOrEqual(width);
        };
        const check = async (titleY?: number) => {
          const now = await geometry();
          expect(now.pageHeight).toBeLessThanOrEqual(height);
          expect(now.pageWidth).toBeLessThanOrEqual(width);
          expect(now.horizontalOverflow).toBe(false);
          expect(Math.abs(now.titleY - now.railY)).toBeLessThanOrEqual(1);
          if (titleY !== undefined) expect(now.titleY).toBe(titleY);
          expect(now.bodyTop).toBeGreaterThanOrEqual(now.headerBottom - 1);
          expect(now.bodyBottom).toBeLessThanOrEqual(height);
          expect(now.contentWidth).toBeLessThanOrEqual(600);
          if (
            now.contentHeight + (width === 1000 ? 60 : 36) <=
            now.bodyHeight
          ) {
            if (width === 720) {
              expect(
                Math.abs(now.contentTop - now.bodyTop - 18),
              ).toBeLessThanOrEqual(1);
            } else {
              expect(Math.abs(now.centerOffset)).toBeLessThanOrEqual(1);
              expect(now.contentTop - now.headerBottom).toBeGreaterThan(29);
            }
          } else {
            expect(now.bodyScroll).toBeGreaterThan(now.bodyClient);
          }
          return now;
        };
        try {
          await open(page, "#signin");
          await page
            .getByRole("button", { name: "Install", exact: true })
            .waitFor();
          await page.evaluate(() => {
            globalThis.__workbench!.setAnswer("sign_in_to_copilotkit", {
              mode: "never",
            });
            globalThis.__workbench!.setAnswer("copilotkit_sign_in_page", {
              mode: "value",
              value: null,
            });
          });
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByText("Checking your OpenBot account…", { exact: true })
            .waitFor();
          await shot("checking");
          const initial = await check();
          expect(await page.locator(".sign-in-wait h3").count()).toBe(0);
          expect(
            await page.locator(".sign-in-wait .step-spinner").count(),
          ).toBe(1);
          await reachable(".sign-in-wait button");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("copilotkit_sign_in_page", {
              mode: "value",
              value: {
                url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
                userCode: "WXYZ-2345",
              },
            }),
          );
          await page.getByText("WXYZ-2345", { exact: true }).waitFor();
          await page.evaluate(() => {
            document.querySelector<HTMLElement>(".setup-body")!.scrollTop = 0;
          });
          await shot("code");
          await check(initial.titleY);
          const code = await page.evaluate(() => {
            const element =
              document.querySelector<HTMLElement>(".sign-in-code")!;
            const box = element.getBoundingClientRect();
            const row = element.parentElement!.getBoundingClientRect();
            const group = element.closest(".sign-in-wait")!;
            const instruction = group.querySelector<HTMLElement>("h3")!;
            const status = group.querySelector<HTMLElement>(".status-line")!;
            return {
              instruction: instruction.textContent,
              status: status.textContent,
              spinners: group.querySelectorAll(".step-spinner").length,
              instructionSize: Number.parseFloat(
                getComputedStyle(instruction).fontSize,
              ),
              statusSize: Number.parseFloat(getComputedStyle(status).fontSize),
              instructionBottom: instruction.getBoundingClientRect().bottom,
              statusTop: status.getBoundingClientRect().top,
              statusBottom: status.getBoundingClientRect().bottom,
              codeTop: row.top,
              left: box.left,
              right: box.right,
              rowLeft: row.left,
              rowRight: row.right,
              width: element.scrollWidth,
              client: element.clientWidth,
              help: group.textContent?.includes("open the sign-in page again"),
              actions: [...group.querySelectorAll("button, a")].map(
                (el) => el.textContent,
              ),
            };
          });
          expect(code.instruction).toBe(
            "Finish signing in to OpenBot in your browser…",
          );
          expect(code.status).toBe("Waiting for you to finish signing in…");
          expect(code.spinners).toBe(1);
          expect(code.instructionSize).toBeGreaterThan(code.statusSize);
          expect(code.instructionBottom).toBeLessThanOrEqual(code.statusTop);
          expect(code.statusBottom).toBeLessThanOrEqual(code.codeTop);
          expect(code.left).toBeGreaterThanOrEqual(code.rowLeft);
          expect(code.right).toBeLessThanOrEqual(code.rowRight);
          expect(code.width).toBeLessThanOrEqual(code.client + 1);
          expect(code.help).toBe(true);
          expect(code.actions).toEqual(["Open the sign-in page", "Cancel"]);
          await reachable(".sign-in-wait a");
          await page
            .getByRole("link", { name: "Open the sign-in page" })
            .click();
          expect(await page.evaluate(() => globalThis.__fake!.opened)).toEqual([
            "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
          ]);
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() => document.activeElement?.textContent),
          ).toBe("Cancel");
          await reachable(".sign-in-wait button");
          // A failed browser approval retains a reachable retry, then starts a fresh attempt.
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("sign_in_to_copilotkit", {
              mode: "fail",
              problem: { said: "Sign-in was interrupted." },
            }),
          );
          await page
            .getByText("Sign-in didn’t finish. Try again.", { exact: true })
            .waitFor();
          await shot("sign-in-failure");
          await check(initial.titleY);
          await reachable(".setup-panel .row button");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("sign_in_to_copilotkit", {
              mode: "never",
            }),
          );
          await page
            .getByRole("button", { name: "Try again", exact: true })
            .click();
          await page.getByText("WXYZ-2345", { exact: true }).waitFor();
          await page
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await page
            .getByRole("button", {
              name: "Sign in for a free local license key",
            })
            .waitFor();
          expect(
            await page.evaluate(() =>
              globalThis.__fake!.calls?.includes("cancel_local_eval"),
            ),
          ).toBe(true);
          await page
            .getByRole("button", {
              name: "Sign in for a free local license key",
            })
            .click();
          await page.getByText("WXYZ-2345", { exact: true }).waitFor();
          await page.evaluate(() => {
            globalThis.__workbench!.setAnswer("local_eval_terms", {
              mode: "value",
              value: { status: "engine-not-ready" },
            });
            globalThis.__workbench!.setAnswer("sign_in_to_copilotkit", {
              mode: "value",
              value: { signedIn: true },
            });
          });
          await page
            .getByRole("heading", { name: "Setting up this computer" })
            .waitFor();
          await shot("engine-wait");
          await check(initial.titleY);
          expect(await page.locator(".sign-in-code").count()).toBe(0);
          await page.evaluate(() => {
            globalThis.__workbench!.setAnswer("connect_copilotkit_apps", {
              mode: "fail",
              problem: {
                said:
                  "OpenBot couldn't connect your apps. " +
                  "Check the internet connection and the organization's sign-in settings before trying again. ".repeat(
                    12,
                  ),
                detail: "The connection was reset while connecting apps.",
              },
            });
            globalThis.__workbench!.setAnswer("local_eval_terms", {
              mode: "value",
              value: { status: "not-required" },
            });
          });
          await page
            .getByRole("heading", { name: "Connect your apps" })
            .waitFor();
          await shot("long-failure");
          await check(initial.titleY);
          await reachable(".setup-panel .row button");
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() => document.activeElement?.textContent),
          ).toBe("Continue");
          await reachable(".setup-panel .row button.quiet");
          await shot("failure-recovery");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});

/** The approved agreement keeps the document, explanation, Read and Accept in one centered group. */
describe.skipIf(!asked)("approved layout: agreement", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    for (const colorScheme of ["dark", "light"] as const) {
      test(`${width}x${height} ${colorScheme}: agreement is whole and centered`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        try {
          await open(page, "#licence-installing");
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Accept the license agreement" })
            .waitFor();
          await settled(page);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/license-${width}-${colorScheme}.png`,
            });
          const geometry = await page.evaluate(() => {
            const sheet =
              document.querySelector<HTMLElement>(".account-layout")!;
            const bodyElement =
              sheet.querySelector<HTMLElement>(".setup-body")!;
            const body = bodyElement.getBoundingClientRect();
            const panel = sheet.querySelector<HTMLElement>(".agreement-panel")!;
            const box = panel.getBoundingClientRect();
            const heading = sheet
              .querySelector<HTMLElement>("h1")!
              .getBoundingClientRect();
            const rail = document
              .querySelector<HTMLElement>(".rail-title")!
              .getBoundingClientRect();
            const link = panel
              .querySelector<HTMLAnchorElement>("a")!
              .parentElement!.getBoundingClientRect();
            const action = panel
              .querySelector<HTMLButtonElement>("button")!
              .getBoundingClientRect();
            const icon = panel
              .querySelector<SVGElement>("svg")
              ?.getBoundingClientRect();
            const explanation = panel
              .querySelector<HTMLElement>("p")!
              .getBoundingClientRect();
            const children = [
              ...panel.querySelectorAll<HTMLElement>("p, a, button, svg"),
            ].map((element) => element.getBoundingClientRect());
            return {
              narrowTopOffset:
                box.top -
                body.top -
                Number.parseFloat(getComputedStyle(bodyElement).paddingTop),
              panelWidth: box.width,
              horizontalCenterOffset:
                (box.left + box.right - body.left - body.right) / 2,
              contentWhole: children.every(
                (child) =>
                  child.left >= box.left &&
                  child.right <= box.right &&
                  child.top >= box.top &&
                  child.bottom <= box.bottom,
              ),
              iconWidth: icon?.width,
              iconHeight: icon?.height,
              iconDecorative: panel
                .querySelector<SVGElement>("svg")
                ?.getAttribute("aria-hidden"),
              iconVisibleBeforeExplanation:
                !!icon &&
                icon.width > 0 &&
                icon.height > 0 &&
                icon.bottom <= explanation.top,
              explanationBeforeRead: explanation.bottom <= link.top,
              pageWidth: document.documentElement.scrollWidth,
              pageHeight: document.documentElement.scrollHeight,
              headingOffset: heading.y - rail.y,
              centerOffset: (box.top + box.bottom - body.top - body.bottom) / 2,
              gap: action.top - link.bottom,
              whole: box.top >= body.top && box.bottom <= body.bottom,
              overflow: panel.scrollWidth > panel.clientWidth,
              documentIcons: panel.querySelectorAll("svg").length,
              explanationColor: getComputedStyle(
                panel.querySelector<HTMLElement>("p")!,
              ).color,
              headingColor: getComputedStyle(
                sheet.querySelector<HTMLElement>("h1")!,
              ).color,
            };
          });
          expect(geometry.pageWidth).toBeLessThanOrEqual(width);
          expect(geometry.pageHeight).toBeLessThanOrEqual(height);
          expect(Math.abs(geometry.headingOffset)).toBeLessThanOrEqual(1);
          if (width === 720)
            expect(Math.abs(geometry.narrowTopOffset)).toBeLessThanOrEqual(1);
          else expect(Math.abs(geometry.centerOffset)).toBeLessThanOrEqual(1);
          expect(geometry.gap).toBeCloseTo(24, 0);
          expect(geometry.whole).toBe(true);
          expect(geometry.overflow).toBe(false);
          expect(geometry.panelWidth).toBeLessThanOrEqual(600);
          expect(Math.abs(geometry.horizontalCenterOffset)).toBeLessThanOrEqual(
            1,
          );
          expect(geometry.contentWhole).toBe(true);
          expect(geometry.explanationBeforeRead).toBe(true);
          const acceptY = (await page
            .getByRole("button", { name: "Accept", exact: true })
            .boundingBox())!.y;
          for (const progress of [
            {
              step: "images",
              ok: true,
              running: true,
              detail: "Downloading OpenBot.",
              downloads: {
                done: 1,
                total: 5,
                bytes: 300_000_000,
                size: 1_100_000_000,
                bytesPerSecond: 9_000_000,
              },
            },
            {
              step: "engine",
              ok: true,
              running: true,
              elsewhere: true,
              detail: DOCKER_STARTING,
            },
          ]) {
            await emitProgress(page, progress);
            await settled(page);
            expect(
              (await page
                .getByRole("button", { name: "Accept", exact: true })
                .boundingBox())!.y,
            ).toBe(acceptY);
          }
          await page.evaluate(() =>
            (globalThis.__fake!.finishInstall as () => void)(),
          );
          await page
            .getByText(/The rest of the install starts after you accept/)
            .waitFor();
          await settled(page);
          expect(
            (await page
              .getByRole("button", { name: "Accept", exact: true })
              .boundingBox())!.y,
          ).toBe(acceptY);
          // Reading never consents: the native legal URL is opened and Accept keeps keyboard order.
          await page.evaluate(() =>
            document
              .querySelector<HTMLAnchorElement>(".agreement-panel a")!
              .focus(),
          );
          await page.keyboard.press("Enter");
          expect(await page.evaluate(() => globalThis.__fake!.opened)).toEqual([
            "https://copilotkit.ai/legal/developer-edition",
          ]);
          expect(
            await page.evaluate(() =>
              globalThis
                .__workbench!.calls()
                .some((call) => call.command === "connect_copilotkit_apps"),
            ),
          ).toBe(false);
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() => document.activeElement?.textContent),
          ).toBe("Accept");
          const reachable = async (selector: string) => {
            const seen = await page.evaluate((selector) => {
              const element = document.querySelector<HTMLElement>(selector)!;
              element.scrollIntoView({ block: "nearest" });
              element.focus();
              const box = element.getBoundingClientRect();
              const body = element
                .closest(".setup-body")!
                .getBoundingClientRect();
              const hit = document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              );
              return {
                focused: document.activeElement === element,
                hit: hit === element || element.contains(hit),
                whole:
                  box.top >= body.top - 1 &&
                  box.bottom <= body.bottom + 1 &&
                  box.left >= 0 &&
                  box.right <= innerWidth,
              };
            }, selector);
            expect(seen).toEqual({ focused: true, hit: true, whole: true });
          };
          await reachable(".agreement-panel button");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("connect_copilotkit_apps", {
              mode: "fail",
              problem: {
                said:
                  "Connection failed. " +
                  "Check your connection and organization settings before trying again. ".repeat(
                    40,
                  ),
                detail: "Connection reset.",
              },
            }),
          );
          await page.keyboard.press("Enter");
          await page
            .getByRole("heading", { name: "Connect your apps" })
            .waitFor();
          await settled(page);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/license-error-${width}-${colorScheme}.png`,
            });
          const recovery = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(
              ".account-layout .setup-body",
            )!;
            return {
              pageHeight: document.documentElement.scrollHeight,
              pageWidth: document.documentElement.scrollWidth,
              scrollable: body.scrollHeight > body.clientHeight,
              bodyOverflow: body.scrollWidth > body.clientWidth,
              headingY: document
                .querySelector<HTMLElement>(".account-layout h1")!
                .getBoundingClientRect().y,
              railY: document
                .querySelector<HTMLElement>(".rail-title")!
                .getBoundingClientRect().y,
            };
          });
          expect(recovery.pageHeight).toBeLessThanOrEqual(height);
          expect(recovery.pageWidth).toBeLessThanOrEqual(width);
          expect(recovery.bodyOverflow).toBe(false);
          expect(recovery.scrollable).toBe(true);
          expect(recovery.headingY).toBe(recovery.railY);
          await reachable(".setup-panel .row button");
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() => document.activeElement?.textContent),
          ).toBe("Continue");
          await reachable(".setup-panel .row button.quiet");
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/license-recovery-${width}-${colorScheme}.png`,
            });
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("connect_copilotkit_apps", {
              mode: "value",
              value: null,
            }),
          );
          await page
            .getByRole("button", { name: "Connect apps", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          expect(
            await page.evaluate(
              () =>
                globalThis
                  .__workbench!.calls()
                  .filter((call) => call.command === "connect_copilotkit_apps")
                  .length,
            ),
          ).toBe(2);
          // Preserve the reference's visible document hierarchy; do not relax these for missing source styling.
          expect(geometry.documentIcons).toBe(1);
          expect(geometry.iconVisibleBeforeExplanation).toBe(true);
          expect(geometry.iconWidth).toBe(28);
          expect(geometry.iconHeight).toBe(28);
          expect(geometry.iconDecorative).toBe("true");
          expect(geometry.explanationColor).toBe(geometry.headingColor);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});

/** Authentication scrolls independently of the selected identity and Continue. */
describe.skipIf(!asked)("approved layout: provider", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    for (const colorScheme of ["dark", "light"] as const) {
      test(`${width}x${height} ${colorScheme}: waiting, error, key, endpoint and signed frames`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const shot = async (state: string) => {
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/provider-${width}-${colorScheme}-${state}.png`,
            });
        };
        const geometry = () =>
          page.evaluate(() => {
            const sheet =
              document.querySelector<HTMLElement>(".provider-layout")!;
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const panel = body.querySelector<HTMLElement>(".chosen-provider")!;
            const identity = sheet.querySelector<HTMLElement>(
              ":scope > .setup-provider-identity",
            )!;
            const footer = sheet.querySelector<HTMLElement>(".setup-footer")!;
            const action =
              footer.querySelector<HTMLButtonElement>("button:last-child")!;
            const b = body.getBoundingClientRect(),
              p = panel.getBoundingClientRect(),
              i = identity.getBoundingClientRect(),
              f = footer.getBoundingClientRect(),
              a = action.getBoundingClientRect();
            const hit = document.elementFromPoint(
              a.x + a.width / 2,
              a.y + a.height / 2,
            );
            return {
              pageWidth: document.documentElement.scrollWidth,
              pageHeight: document.documentElement.scrollHeight,
              bodyBottom: b.bottom,
              footerTop: f.top,
              actionY: a.y,
              actionWhole: a.y >= 0 && a.bottom <= innerHeight,
              actionHit: !!hit && action.contains(hit),
              identity: { x: i.x, y: i.y, width: i.width, height: i.height },
              identityOutsideScroller: identity.parentElement === sheet,
              bodyOverflow: body.scrollWidth > body.clientWidth,
              panelWidth: p.width,
              leftOffset: p.left - b.left,
              centerY: (p.top + p.bottom - b.top - b.bottom) / 2,
              topOffset:
                p.top -
                b.top -
                Number.parseFloat(getComputedStyle(body).paddingTop),
            };
          });
        let baseline: Awaited<ReturnType<typeof geometry>> | undefined;
        const check = async () => {
          const now = await geometry();
          expect(now.pageWidth).toBeLessThanOrEqual(width);
          expect(now.pageHeight).toBeLessThanOrEqual(height);
          expect(now.bodyBottom).toBeLessThanOrEqual(now.footerTop + 1);
          expect(now.actionWhole).toBe(true);
          expect(now.actionHit).toBe(true);
          expect(now.identityOutsideScroller).toBe(true);
          expect(now.bodyOverflow).toBe(false);
          expect(now.panelWidth).toBeLessThanOrEqual(600);
          expect(Math.abs(now.leftOffset)).toBeLessThanOrEqual(1);
          if (baseline) {
            expect(
              Math.abs(now.actionY - baseline.actionY),
            ).toBeLessThanOrEqual(1);
            expect(now.identity).toEqual(baseline.identity);
          }
          return now;
        };
        const reach = async (selector: string) => {
          expect(
            await page.evaluate((selector) => {
              const element = document.querySelector<HTMLElement>(selector)!;
              element.focus();
              element.scrollIntoView({ block: "nearest" });
              const b = element.getBoundingClientRect(),
                body = element
                  .closest<HTMLElement>(".setup-body")!
                  .getBoundingClientRect();
              // An inline link can wrap. Hit a real line box, rather than the empty center
              // of its enclosing bounding rectangle between two lines.
              const point = element.getClientRects()[0] ?? b;
              const hit = document.elementFromPoint(
                point.x + point.width / 2,
                point.y + point.height / 2,
              );
              return {
                focused: document.activeElement === element,
                whole: b.top >= body.top - 1 && b.bottom <= body.bottom + 1,
                hit: !!hit && element.contains(hit),
              };
            }, selector),
          ).toEqual({ focused: true, whole: true, hit: true });
          await check();
        };
        try {
          await open(page);
          await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
          await page.evaluate(async () => {
            const catalogue = (await globalThis.__workbench!.call(
              "providers",
            )) as { id: string; caution: unknown }[];
            globalThis.__workbench!.setAnswer("providers", {
              mode: "value",
              value: catalogue.map((row) =>
                row.id === "anthropic"
                  ? {
                      ...row,
                      caution: {
                        says: "A Claude plan carries a separate monthly pool of Agent SDK credits. When that pool is empty, Bots stop until it renews or you add API credits.",
                        reads_more_at: "https://openbot.test/plan-credits",
                      },
                    }
                  : row,
              ),
            });
            globalThis.__workbench!.setAnswer("begin_claude_sign_in", {
              mode: "value",
              value: "https://openbot.test/approve",
            });
            globalThis.__workbench!.setAnswer("finish_claude_sign_in", {
              mode: "never",
            });
          });
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          await page.getByText("Anthropic", { exact: true }).click();
          await settled(page);
          baseline = await check();
          await shot("long-caution");
          await page
            .getByRole("button", {
              name: "Sign in with Anthropic",
              exact: true,
            })
            .click();
          await page
            .getByText("Waiting for you to approve it…", { exact: true })
            .waitFor();
          await settled(page);
          await page.evaluate(() => {
            document.querySelector<HTMLElement>(
              ".provider-layout .setup-body",
            )!.scrollTop = 0;
          });
          const waiting = await check();
          if (width === 1000)
            expect(Math.abs(waiting.centerY)).toBeLessThanOrEqual(1);
          else expect(Math.abs(waiting.topOffset)).toBeLessThanOrEqual(1);
          await shot("waiting");
          // The initial narrow view must say what is happening before the fallback link.
          const waitingStatus = await page
            .getByText("Waiting for you to approve it…", { exact: true })
            .boundingBox();
          expect(waitingStatus).not.toBeNull();
          expect(waitingStatus!.y).toBeGreaterThanOrEqual(
            waiting.identity.y + waiting.identity.height,
          );
          expect(waitingStatus!.y + waitingStatus!.height).toBeLessThanOrEqual(
            waiting.bodyBottom + 1,
          );
          await reach(".chosen-provider .caution a");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("finish_claude_sign_in", {
              mode: "fail",
              problem: {
                said: "OpenBot could not finish signing in. Check your connection and try again.",
                detail:
                  "The sign-in service could not be reached. Try signing in again after the connection is restored.",
              },
            }),
          );
          await page
            .getByText(
              "OpenBot could not finish signing in. Check your connection and try again.",
              { exact: true },
            )
            .waitFor();
          await settled(page);
          await check();
          await shot("error");
          await page
            .getByRole("tab", { name: "Use an API key", exact: true })
            .click();
          await page
            .getByLabel("Anthropic API key", { exact: true })
            .fill("test-provider-key");
          await settled(page);
          await reach("#key");
          await shot("api-key");
          let continueFocused = false;
          for (let n = 0; n < 12 && !continueFocused; n++) {
            await page.keyboard.press("Tab");
            continueFocused = await page.evaluate(
              () =>
                document.activeElement ===
                document.querySelector<HTMLElement>(
                  ".setup-footer button:last-child",
                ),
            );
          }
          expect(continueFocused).toBe(true);
          await check();
          await page
            .getByRole("button", { name: "Choose a different provider" })
            .click();
          await page
            .getByText("Any OpenAI-compatible endpoint", { exact: true })
            .click();
          await page
            .getByLabel("Base URL", { exact: true })
            .fill("https://models.example.test/v1");
          await page
            .getByText("Advanced compatible endpoint options", { exact: true })
            .click();
          await page
            .getByLabel("Container Base URL, if different", { exact: true })
            .fill("http://model:11434/v1");
          await page
            .getByLabel("Model name", { exact: true })
            .fill("test-model");
          await settled(page);
          const endpoint = await geometry();
          expect(
            Math.abs(endpoint.actionY - baseline.actionY),
          ).toBeLessThanOrEqual(1);
          baseline = endpoint;
          for (const selector of [
            "#base",
            "#container-base",
            "#model",
            "#ekey",
          ])
            await reach(selector);
          await shot("endpoint");
          const beforeDownload = await measure(page);
          await page.evaluate(() => {
            globalThis.__fake!.download = {
              done: 400_000_000,
              total: 1_600_000_000,
            };
          });
          await page.getByText("400.0 MB of 1.6 GB").waitFor();
          expect(await measure(page)).toEqual(beforeDownload);
          await check();
          await page.evaluate(() => {
            globalThis.__fake!.download = null;
          });
          await page
            .getByText("400.0 MB of 1.6 GB")
            .waitFor({ state: "hidden" });
          expect(await measure(page)).toEqual(beforeDownload);
          await page.evaluate(() =>
            (
              globalThis.__fake as unknown as { finishSetUp(): void }
            ).finishSetUp(),
          );
          await page
            .getByText("OpenBot is installed", { exact: true })
            .waitFor();
          expect(await measure(page)).toEqual(beforeDownload);
          await check();
          await page
            .getByRole("button", { name: "Choose a different provider" })
            .click();
          await page.getByText("Anthropic", { exact: true }).click();
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("finish_claude_sign_in", {
              mode: "never",
            }),
          );
          await page
            .getByRole("button", {
              name: "Sign in with Anthropic",
              exact: true,
            })
            .click();
          await page
            .getByText("Waiting for you to approve it…", { exact: true })
            .waitFor();
          await settled(page);
          baseline = await geometry();
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("finish_claude_sign_in", {
              mode: "value",
              value: "test-provider-token",
            }),
          );
          await page
            .getByText("Signed in to Anthropic.", { exact: false })
            .waitFor();
          await check();
          await shot("signed");
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});
describe.skipIf(!asked)("approved layout: install", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`${width}x${height} ${colorScheme}: download, unpack, prompt, failure and completion`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const emit = (payload: Record<string, unknown>) =>
          page.evaluate(
            (payload) =>
              globalThis.__workbench!.emit("setup:progress", payload),
            payload,
          );
        const shot = async (state: string) => {
          await settled(page);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/install-${width}-${colorScheme}-${state}.png`,
            });
        };
        const geometry = () =>
          page.evaluate(() => {
            const sheet =
              document.querySelector<HTMLElement>(".install-layout")!;
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const content = body.querySelector<HTMLElement>(".setup-content")!;
            const footer = sheet.querySelector<HTMLElement>(".setup-footer")!;
            const header = sheet.querySelector<HTMLElement>(
              ".setup-header-block",
            )!;
            const b = body.getBoundingClientRect(),
              c = content.getBoundingClientRect(),
              f = footer.getBoundingClientRect(),
              h = header.getBoundingClientRect();
            const rows = [
              ...sheet.querySelectorAll<HTMLElement>(
                ".setup-progress-focus > .step",
              ),
            ];
            return {
              pageWidth: document.documentElement.scrollWidth,
              pageHeight: document.documentElement.scrollHeight,
              horizontalOverflow: [body, content, ...rows].some(
                (e) => e.scrollWidth > e.clientWidth + 1,
              ),
              headerBottom: h.bottom,
              bodyTop: b.top,
              bodyBottom: b.bottom,
              bodyHeight: b.height,
              footerTop: f.top,
              footerBottom: f.bottom,
              contentWidth: c.width,
              contentHeight: c.height,
              centerX: (c.left + c.right - b.left - b.right) / 2,
              centerY: (c.top + c.bottom - b.top - b.bottom) / 2,
              topOffset:
                c.top +
                body.scrollTop -
                b.top -
                Number.parseFloat(getComputedStyle(body).paddingTop),
              rows: rows.map((row) => ({
                label: row.getAttribute("aria-label"),
                top: row.getBoundingClientRect().top,
                current: !!row.querySelector(
                  ".mark.active, .mark.waiting, .mark.bad",
                ),
                labelSize: Number.parseFloat(
                  getComputedStyle(
                    row.querySelector<HTMLElement>(".step-label")!,
                  ).fontSize,
                ),
                background: getComputedStyle(row).backgroundColor,
                border: Number.parseFloat(
                  getComputedStyle(row).borderRightWidth,
                ),
              })),
            };
          });
        const check = async () => {
          await settled(page);
          const now = await geometry();
          expect(now.pageWidth).toBeLessThanOrEqual(width);
          expect(now.pageHeight).toBeLessThanOrEqual(height);
          expect(now.horizontalOverflow).toBe(false);
          expect(now.bodyTop).toBeGreaterThanOrEqual(now.headerBottom - 1);
          expect(now.bodyBottom).toBeLessThanOrEqual(now.footerTop + 1);
          expect(now.footerBottom).toBeLessThanOrEqual(height);
          expect(now.contentWidth).toBeLessThanOrEqual(600);
          expect(Math.abs(now.centerX)).toBeLessThanOrEqual(1);
          if (width === 1000 && now.contentHeight + 60 <= now.bodyHeight)
            expect(Math.abs(now.centerY)).toBeLessThanOrEqual(1);
          if (width === 720)
            expect(Math.abs(now.topOffset)).toBeLessThanOrEqual(1);
          const current = now.rows.findIndex((row) => row.current);
          if (current >= 0) expect(current).toBe(0);
          if (now.rows.length > 1 && now.rows[0]?.current) {
            expect(now.rows[0].labelSize).toBeGreaterThan(
              now.rows[1]!.labelSize,
            );
            expect(now.rows[0].border).toBe(0);
            expect(now.rows[1]!.border).toBe(0);
            expect(now.rows[1]!.top).toBeGreaterThan(now.rows[0].top);
          }
          return now;
        };
        const reach = async (label: string) => {
          // Use actual Tab navigation; programmatic focus alone does not establish keyboard reachability.
          let focused = false;
          for (let n = 0; n < 30 && !focused; n++) {
            await page.keyboard.press("Tab");
            focused = await page.evaluate(
              (label) => document.activeElement?.textContent?.trim() === label,
              label,
            );
          }
          expect(focused).toBe(true);
          expect(
            await page.evaluate((label) => {
              const element = [
                ...document.querySelectorAll<HTMLButtonElement>(
                  ".install-layout button",
                ),
              ].find((e) => e.textContent?.trim() === label)!;
              const r = element.getBoundingClientRect(),
                hit = document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                );
              const container = element
                .closest<HTMLElement>(".setup-body, .setup-footer")!
                .getBoundingClientRect();
              return {
                hit: !!hit && element.contains(hit),
                visible:
                  r.top >= container.top - 1 &&
                  r.bottom <= container.bottom + 1 &&
                  r.bottom <= innerHeight &&
                  r.left >= 0 &&
                  r.right <= innerWidth,
                enabled: !element.disabled,
              };
            }, label),
          ).toEqual({ hit: true, visible: true, enabled: true });
        };
        try {
          await open(page, "#licence-installing");
          await page
            .getByRole("button", { name: "Install", exact: true })
            .waitFor();
          await page.evaluate(() => {
            globalThis.__workbench!.setAnswer("prepare_installation", {
              mode: "never",
            });
            globalThis.__workbench!.setAnswer("allow_podman_install", {
              mode: "value",
              value: true,
            });
            globalThis.__workbench!.setAnswer("set_up_local_eval", {
              mode: "never",
            });
          });
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Accept", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Installing OpenBot", exact: true })
            .waitFor();
          await emit({
            step: "engine",
            ok: true,
            running: false,
            detail: "The software OpenBot runs on is ready.",
          });
          await emit({
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading local software.",
            downloads: {
              bytes: 568_900_000,
              size: 872_800_000,
              done: 2,
              total: 5,
              bytesPerSecond: 9_000_000,
            },
          });
          await page
            .getByText("568.9 MB of 872.8 MB", { exact: false })
            .waitFor();
          const download = await check();
          expect(download.rows[0]?.label).toBe("Downloading OpenBot");
          expect(download.rows[1]?.label).toBe("Preparing this computer");
          expect(
            await page
              .getByRole("button", { name: "Cancel", exact: true })
              .count(),
          ).toBe(0);
          await shot("download");
          await emit({
            step: "images",
            ok: true,
            running: true,
            detail: "Unpacking local software.",
            downloads: {
              bytes: 872_800_000,
              size: 872_800_000,
              done: 2,
              total: 5,
            },
          });
          await page
            .getByText("Unpacking OpenBot (3 of 5).", { exact: false })
            .waitFor();
          await check();
          await shot("unpack");
          // Before macOS's password prompt: why, and Continue, in reach at every size. The prompt
          // comes only on Continue.
          await emit({
            step: "install-engine",
            ok: true,
            running: true,
            asks: true,
            beforePrompt: true,
            detail:
              "OpenBot needs to install the software it runs on. Choose Continue, then enter your Mac password when your Mac asks for it.",
          });
          await page
            .getByRole("region", {
              name: "Your Mac will ask for your password",
            })
            .waitFor();
          await check();
          await reach("Continue");
          await shot("before-prompt");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          expect(
            await page.evaluate(
              () =>
                globalThis
                  .__workbench!.calls()
                  .filter((c) => c.command === "allow_podman_install").length,
            ),
          ).toBe(1);
          const asking =
            "OpenBot needs your password to install what it needs to run. Try again to open the password prompt.";
          await emit({
            step: "install-engine",
            ok: true,
            running: true,
            asks: true,
            detail: asking,
          });
          await page
            .getByRole("region", { name: "Your password is needed" })
            .waitFor();
          await check();
          await reach("Try again");
          await shot("prompt");
          await page
            .getByRole("button", { name: "Try again", exact: true })
            .click();
          expect(
            await page.evaluate(
              () =>
                globalThis
                  .__workbench!.calls()
                  .filter((c) => c.command === "allow_podman_install").length,
            ),
          ).toBe(2);
          await emit({
            step: "install-engine",
            ok: true,
            running: false,
            detail: "Ready.",
          });
          await emit({
            step: "images",
            ok: false,
            running: false,
            detail: "The download was interrupted.",
          });
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("prepare_installation", {
              mode: "fail",
              problem: {
                said: "The download was interrupted. Check your internet connection and retry installation.",
                detail: "Connection reset while downloading OpenBot.",
              },
            }),
          );
          await page
            .getByRole("button", { name: "Retry installation", exact: true })
            .waitFor();
          await check();
          await reach("Back");
          await reach("Retry installation");
          await shot("failure");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("prepare_installation", {
              mode: "value",
              value: null,
            }),
          );
          await page
            .getByRole("button", { name: "Retry installation", exact: true })
            .click();
          // Successful installation advances automatically to AI, preserving the real flow.
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          await shot("complete");
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});

describe.skipIf(!asked)("approved layout: finishing", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const)
      test(`${width}x${height} ${colorScheme}: current phases, cancellation and reachable recovery`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const shot = async (state: string) => {
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/finish-${width}-${colorScheme}-${state}.png`,
            });
        };
        const geometry = () =>
          page.evaluate(() => {
            const sheet =
              document.querySelector<HTMLElement>(".finishing-layout")!;
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const content = body.querySelector<HTMLElement>(".setup-content")!;
            const footer = sheet.querySelector<HTMLElement>(
              ":scope > .setup-footer",
            )!;
            const checkbox = footer.querySelector<HTMLInputElement>(
              'input[type="checkbox"]',
            )!;
            const b = body.getBoundingClientRect(),
              c = content.getBoundingClientRect(),
              f = footer.getBoundingClientRect(),
              a = checkbox.getBoundingClientRect();
            const hit = document.elementFromPoint(
              a.x + a.width / 2,
              a.y + a.height / 2,
            );
            const memory = globalThis as unknown as {
              finishingConsent?: Element;
            };
            memory.finishingConsent ??= checkbox;
            return {
              sameConsent: memory.finishingConsent === checkbox,
              settingsReads: globalThis
                .__workbench!.calls()
                .filter(
                  (call) =>
                    call.command === "plugin:openbot-desktop|usage_data",
                ).length,
              pageWidth: document.documentElement.scrollWidth,
              pageHeight: document.documentElement.scrollHeight,
              horizontalOverflow: body.scrollWidth > body.clientWidth,
              bodyBottom: b.bottom,
              footerTop: f.top,
              checkbox: { x: a.x, y: a.y },
              checkboxWhole: a.top >= 0 && a.bottom <= innerHeight,
              checkboxHit: hit === checkbox,
              contentWidth: c.width,
              centerX: (c.left + c.right - b.left - b.right) / 2,
              centerY: (c.top + c.bottom - b.top - b.bottom) / 2,
              topOffset:
                c.top -
                b.top +
                body.scrollTop -
                Number.parseFloat(getComputedStyle(body).paddingTop),
              fits: body.scrollHeight <= body.clientHeight + 1,
              spinners: sheet.querySelectorAll(".step-spinner").length,
              journey: sheet.querySelectorAll(".journey").length,
              milestones: [
                ...sheet.querySelectorAll(".setup-milestones > .step"),
              ].map((row) => ({
                running: row.querySelector(".step-spinner") !== null,
                text: row.textContent ?? "",
              })),
            };
          });
        let consent: { x: number; y: number } | undefined;
        let settingsReads: number | undefined;
        const check = async (journey: boolean, state: string) => {
          await settled(page);
          const now = await geometry();
          expect(now.sameConsent).toBe(true);
          if (settingsReads === undefined) settingsReads = now.settingsReads;
          expect(now.settingsReads).toBe(settingsReads);
          expect(now.settingsReads).toBeGreaterThan(0);
          expect(now.pageWidth).toBeLessThanOrEqual(width);
          expect(now.pageHeight).toBeLessThanOrEqual(height);
          expect(now.horizontalOverflow).toBe(false);
          expect(now.bodyBottom).toBeLessThanOrEqual(now.footerTop + 1);
          expect(now.checkboxWhole).toBe(true);
          expect(now.checkboxHit).toBe(true);
          expect(now.contentWidth).toBeLessThanOrEqual(600);
          expect(Math.abs(now.centerX)).toBeLessThanOrEqual(1);
          if (width === 720)
            expect(Math.abs(now.topOffset)).toBeLessThanOrEqual(1);
          else if (now.fits)
            expect(Math.abs(now.centerY)).toBeLessThanOrEqual(1);
          if (consent) expect(now.checkbox).toEqual(consent);
          else consent = now.checkbox;
          expect(now.journey).toBe(journey ? 1 : 0);
          expect(now.spinners).toBe(journey ? 1 : 0);
          if (journey)
            for (const row of now.milestones) {
              expect(row.running).toBe(false);
              expect(row.text).not.toMatch(/Failed|Waiting|Paused/);
              expect(row.text).toContain("Complete");
            }
          await page.evaluate(() => {
            document.querySelector<HTMLElement>(
              ".finishing-layout .setup-body",
            )!.scrollTop = 0;
          });
          await shot(state);
        };
        const reach = async (name: string) => {
          const button = page
            .locator(".finishing-layout")
            .getByRole("button", { name, exact: true });
          await button.waitFor();
          const result = await page.evaluate((name) => {
            const button = [
              ...document.querySelectorAll<HTMLButtonElement>(
                ".finishing-layout button",
              ),
            ].find((button) => button.textContent?.trim() === name)!;
            button.scrollIntoView({ block: "nearest" });
            button.focus();
            const a = button.getBoundingClientRect();
            const body = button
              .closest<HTMLElement>(".setup-body")!
              .getBoundingClientRect();
            const hit = document.elementFromPoint(
              a.x + a.width / 2,
              a.y + a.height / 2,
            );
            return {
              focused: document.activeElement === button,
              whole: a.top >= body.top - 1 && a.bottom <= body.bottom + 1,
              hit: hit !== null && button.contains(hit),
            };
          }, name);
          expect(result).toEqual({ focused: true, whole: true, hit: true });
        };
        const releaseSetup = async () =>
          page.evaluate(() => (globalThis.__fake!.finishSetUp as () => void)());
        const hold = async (command: string) =>
          page.evaluate(
            (command) =>
              globalThis.__workbench!.setAnswer(command, { mode: "never" }),
            command,
          );
        try {
          await toTheAiStep(page);
          await hold("connect_local_eval");
          await hold("run_local_eval");
          await hold("start_stack");
          await page.getByText("Anthropic", { exact: true }).click();
          await page
            .getByRole("tab", { name: "Use an API key", exact: true })
            .click();
          await page
            .getByLabel("Anthropic API key", { exact: true })
            .fill("a-key-for-this-test");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Finishing setup" })
            .waitFor();
          await page.locator(".journey").waitFor();
          await check(true, "setup");
          await reach("Cancel");
          await page
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await reach("Retry");
          await check(false, "cancelled");
          expect(
            await page.evaluate(() =>
              globalThis
                .__workbench!.calls()
                .some((call) => call.command === "cancel_local_eval"),
            ),
          ).toBe(true);
          await page
            .getByRole("button", { name: "Retry", exact: true })
            .click();
          await page.locator(".journey").waitFor();
          await check(true, "setup-retry");
          await releaseSetup();
          await page
            .getByText("Connecting OpenBot to its services", { exact: true })
            .waitFor();
          await check(true, "connect");
          // Use recorded setup report instead of calling the paused run_local_eval command.
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("connect_local_eval", {
              mode: "value",
              value: {
                outcome: "completed",
                stack: { id: "local-abc123" },
                reason: null,
                conflicted: false,
              },
            }),
          );
          await page
            .getByRole("listitem", { name: "Connecting OpenBot", exact: true })
            .waitFor();
          await check(true, "wait");
          await reach("Cancel");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("run_local_eval", {
              mode: "value",
              value: {
                outcome: "completed",
                stack: {
                  id: "local-abc123",
                  installedRelease: "0.16.0-rc.10",
                  step: "ready",
                  urls: {
                    api: "http://127.0.0.1:64770",
                    dashboard: "http://127.0.0.1:64771",
                    gateway: "ws://127.0.0.1:64772",
                  },
                  hasFailedStep: false,
                  updateInProgress: false,
                  unfinishedUpdate: null,
                  observed: null,
                },
                reason: null,
                readiness: "ready",
                licence: "valid",
                licenceExpiresAt: null,
                checksPassed: false,
              },
            }),
          );
          await page.locator(".cannot-cancel").waitFor();
          expect(
            await page
              .getByRole("button", { name: "Cancel", exact: true })
              .count(),
          ).toBe(0);
          expect(await page.locator(".cannot-cancel").textContent()).toContain(
            "half started",
          );
          await check(true, "start");
          // Exercise a real failure and Retry from the native Start call.
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("start_stack", {
              mode: "fail",
              problem: {
                said: "OpenBot could not start. Retry, and copy the logs if it stops again.",
              },
            }),
          );
          await reach("Retry");
          const logActions = await page.evaluate(() =>
            [...document.querySelectorAll(".finishing-layout button")]
              .filter((button) =>
                ["Copy logs", "Save to a file"].includes(
                  button.textContent?.trim() ?? "",
                ),
              )
              .map((button) => button.textContent?.trim()),
          );
          // Check every offered log action before the exact-count assertion below.
          const logsReachable = await page.evaluate(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                ".finishing-layout button",
              ),
            ]
              .filter((button) =>
                ["Copy logs", "Save to a file"].includes(
                  button.textContent?.trim() ?? "",
                ),
              )
              .map((button) => {
                button.scrollIntoView({ block: "nearest" });
                button.focus();
                const a = button.getBoundingClientRect(),
                  b = button
                    .closest<HTMLElement>(".setup-body")!
                    .getBoundingClientRect();
                const hit = document.elementFromPoint(
                  a.x + a.width / 2,
                  a.y + a.height / 2,
                );
                return {
                  focused: document.activeElement === button,
                  whole: a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
                  hit: !!hit && button.contains(hit),
                };
              }),
          );
          for (const reachable of logsReachable)
            expect(reachable).toEqual({
              focused: true,
              whole: true,
              hit: true,
            });
          await reach("Back");
          await check(false, "failure");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("start_stack", { mode: "never" }),
          );
          await page
            .getByRole("button", { name: "Retry", exact: true })
            .click();
          await page.locator(".journey").waitFor();
          await check(true, "retry");
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("start_stack", {
              mode: "fail",
              problem: {
                said: "OpenBot found data from a previous installation.",
                leftover_reset: [
                  "openbot_agent-profiles",
                  "openbot-workspace-general-assistant",
                ],
                leftover_containers: ["openbot-agent-computer-1"],
              },
            }),
          );
          await page
            .getByRole("heading", {
              name: "A previous OpenBot installation left data here",
            })
            .waitFor();
          await reach("Start fresh");
          await reach("Back");
          expect(
            await page
              .getByRole("button", { name: "Retry", exact: true })
              .count(),
          ).toBe(0);
          await check(false, "leftover");
          await page.evaluate(() =>
            document
              .querySelector<HTMLInputElement>(
                '.usage-choice input[type="checkbox"]',
              )!
              .focus(),
          );
          await page.keyboard.press("Space");
          await settled(page);
          expect(
            await page.evaluate(() =>
              globalThis
                .__workbench!.calls()
                .filter(
                  (call) =>
                    call.command === "plugin:openbot-desktop|set_usage_data",
                )
                .map((call) => call.args?.share),
            ),
          ).toEqual([false]);
          expect(
            await page.evaluate(
              () =>
                document.querySelector<HTMLInputElement>(
                  '.usage-choice input[type="checkbox"]',
                )!.checked,
            ),
          ).toBe(false);
          await check(false, "consent-changed");
          expect(logActions).toEqual(["Copy logs", "Save to a file"]);
        } finally {
          await page.close();
        }
      }, 60_000);
});

describe.skipIf(!asked)("approved layout: finishing", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const)
      test(`${width}x${height} ${colorScheme}: held setup, lost backend and Start fresh`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const state = async () => {
          await settled(page);
          return page.evaluate(() => {
            const sheet =
              document.querySelector<HTMLElement>(".finishing-layout")!;
            const body = sheet.querySelector<HTMLElement>(".setup-body")!;
            const footer = sheet.querySelector<HTMLElement>(
              ":scope > .setup-footer",
            )!;
            const checkbox = footer.querySelector<HTMLInputElement>(
              'input[type="checkbox"]',
            )!;
            const b = body.getBoundingClientRect(),
              f = footer.getBoundingClientRect(),
              a = checkbox.getBoundingClientRect();
            const memory = globalThis as unknown as { heldConsent?: Element };
            memory.heldConsent ??= checkbox;
            return {
              sameConsent: memory.heldConsent === checkbox,
              settingsReads: globalThis
                .__workbench!.calls()
                .filter(
                  (call) =>
                    call.command === "plugin:openbot-desktop|usage_data",
                ).length,
              width: document.documentElement.scrollWidth,
              height: document.documentElement.scrollHeight,
              overflow: body.scrollWidth > body.clientWidth,
              overlap: b.bottom > f.top + 1,
              consent: { x: a.x, y: a.y },
              consentWhole: a.top >= 0 && a.bottom <= innerHeight,
              consentHit:
                document.elementFromPoint(
                  a.x + a.width / 2,
                  a.y + a.height / 2,
                ) === checkbox,
              spinners: sheet.querySelectorAll(".step-spinner").length,
              journeys: sheet.querySelectorAll(".journey").length,
            };
          });
        };
        const reach = async (name: string) => {
          expect(
            await page.evaluate((name) => {
              const button = [
                ...document.querySelectorAll<HTMLButtonElement>(
                  ".finishing-layout button",
                ),
              ].find((button) => button.textContent?.trim() === name)!;
              button.scrollIntoView({ block: "nearest" });
              button.focus();
              const b = button.getBoundingClientRect(),
                body = button
                  .closest<HTMLElement>(".setup-body")!
                  .getBoundingClientRect();
              const hit = document.elementFromPoint(
                b.x + b.width / 2,
                b.y + b.height / 2,
              );
              return {
                focused: document.activeElement === button,
                whole: b.top >= body.top - 1 && b.bottom <= body.bottom + 1,
                hit: hit !== null && button.contains(hit),
              };
            }, name),
          ).toEqual({ focused: true, whole: true, hit: true });
        };
        const shot = async (name: string) => {
          await page.evaluate(() => {
            document.querySelector<HTMLElement>(
              ".finishing-layout .setup-body",
            )!.scrollTop = 0;
          });
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/finish-${width}-${colorScheme}-${name}.png`,
            });
        };
        try {
          await open(page);
          await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
          await page.evaluate(() => {
            const shortfall = {
              podman: true,
              cpu: false,
              memory: false,
              disk: true,
              diskGb: "7.4",
              freeOnDrive: true,
              mac: true,
              neededGb: "13",
            };
            globalThis.__workbench!.setAnswer("set_up_local_eval", {
              mode: "value",
              value: {
                outcome: "blocked",
                stack: null,
                reason: "resources-short",
                readiness: "unknown",
                licence: "unknown",
                licenceExpiresAt: null,
                checksPassed: false,
                shortfall,
              },
            });
            globalThis.__workbench!.setAnswer("local_eval_room", {
              mode: "value",
              value: shortfall,
            });
          });
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          await page.getByText("Anthropic", { exact: true }).click();
          await page
            .getByRole("tab", { name: "Use an API key", exact: true })
            .click();
          await page
            .getByLabel("Anthropic API key", { exact: true })
            .fill("a-key-for-this-test");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Finishing setup" })
            .waitFor();
          await page
            .getByRole("button", { name: "Try again", exact: true })
            .waitFor();
          await reach("Try again");
          await reach("Cancel");
          const held = await state();
          expect(held.width).toBeLessThanOrEqual(width);
          expect(held.height).toBeLessThanOrEqual(height);
          expect(held.overflow).toBe(false);
          expect(held.overlap).toBe(false);
          expect(held.sameConsent).toBe(true);
          expect(held.settingsReads).toBeGreaterThan(0);
          expect(held.consentWhole).toBe(true);
          expect(held.consentHit).toBe(true);
          expect(held.spinners).toBe(0);
          expect(held.journeys).toBe(0);
          await shot("held");
          await page.evaluate(() => {
            globalThis.__workbench!.setAnswer("local_eval_room", {
              mode: "value",
              value: null,
            });
            globalThis.__workbench!.setAnswer("set_up_local_eval", {
              mode: "value",
              value: {
                outcome: "failed",
                stack: null,
                reason: "stack-lost",
                readiness: "unknown",
                licence: "unknown",
                licenceExpiresAt: null,
                checksPassed: false,
              },
            });
          });
          await page
            .getByRole("button", { name: "Try again", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Start fresh", exact: true })
            .waitFor();
          await reach("Start fresh");
          await reach("Back");
          expect(
            await page
              .getByRole("button", { name: "Retry", exact: true })
              .count(),
          ).toBe(0);
          const lost = await state();
          expect(lost).toEqual(held);
          await shot("stack-lost");
          // A real Tab traversal reaches diagnostics from the last recovery action.
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(() =>
              document.activeElement?.matches(
                '.usage-choice input[type="checkbox"]',
              ),
            ),
          ).toBe(true);
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("set_up_local_eval", {
              mode: "never",
            }),
          );
          await page
            .getByRole("button", { name: "Start fresh", exact: true })
            .click();
          await page.locator(".finishing-layout .journey").waitFor();
          const resumed = await state();
          expect(resumed.journeys).toBe(1);
          expect(resumed.spinners).toBe(1);
          expect(resumed.consent).toEqual(held.consent);
          expect(resumed.sameConsent).toBe(true);
          expect(resumed.settingsReads).toBe(held.settingsReads);
          expect(resumed.overlap).toBe(false);
          expect(resumed.overflow).toBe(false);
          await shot("fresh-recovery");
        } finally {
          await page.close();
        }
      }, 60_000);
});

describe.skipIf(!asked)("approved layout: booking", () => {
  const calendarMessage = async (
    page: Page,
    event: string,
    reportedHeight?: string,
  ) => {
    await page.evaluate(
      ({ event, reportedHeight }) =>
        new Promise<void>((resolve, reject) => {
          const frame = document.querySelector<HTMLIFrameElement>(
            'iframe[title="Booking calendar"]',
          )!;
          const send = () =>
            frame.contentWindow!.postMessage(
              { testCalendar: { event, payload: { height: reportedHeight } } },
              "*",
            );
          const receive = (message: MessageEvent) => {
            if (
              message.origin === "https://calendly.com" &&
              message.source === frame.contentWindow &&
              message.data?.testCalendarAck
            ) {
              clearInterval(retry);
              clearTimeout(timeout);
              window.removeEventListener("message", receive);
              resolve();
            }
          };
          window.addEventListener("message", receive);
          const retry = setInterval(send, 25);
          const timeout = setTimeout(() => {
            clearInterval(retry);
            window.removeEventListener("message", receive);
            reject(new Error("calendar fixture did not acknowledge message"));
          }, 5000);
          send();
        }),
      { event, reportedHeight },
    );
    await settled(page);
  };
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const) {
      test(`${width}x${height} ${colorScheme}: loading, ready and fallback reserve the same surface and Back`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const shot = async (state: string) => {
          await settled(page);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/booking-${state}-${width}x${height}-${colorScheme}.png`,
            });
        };
        const geometry = () =>
          page.evaluate(() => {
            const owner = document.querySelector<HTMLElement>(".booking-step")!;
            const body = owner.querySelector<HTMLElement>(".setup-body")!;
            const surface = owner.querySelector<HTMLElement>(
              ".setup-booking-surface",
            )!;
            const footer = owner.querySelector<HTMLElement>(".setup-footer")!;
            const back = footer.querySelector<HTMLElement>("button")!;
            const box = (element: HTMLElement) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            };
            const b = back.getBoundingClientRect();
            const hit = document.elementFromPoint(
              b.x + b.width / 2,
              b.y + b.height / 2,
            );
            return {
              surface: box(surface),
              footer: box(footer),
              back: box(back),
              header: box(
                owner.querySelector<HTMLElement>(".setup-header-block")!,
              ),
              body: box(body),
              titleY: owner.querySelector("h2")!.getBoundingClientRect().y,
              railY: document
                .querySelector(".rail-title")!
                .getBoundingClientRect().y,
              pageHeight: document.documentElement.scrollHeight,
              pageWidth: document.documentElement.scrollWidth,
              sideways: [
                ...owner.querySelectorAll<HTMLElement>(
                  ".setup-body, .setup-booking-surface, .setup-footer",
                ),
              ].some(
                (element) => element.scrollWidth > element.clientWidth + 1,
              ),
              frame: owner.querySelector<HTMLIFrameElement>("iframe")
                ? box(owner.querySelector<HTMLIFrameElement>("iframe")!)
                : null,
              bodyScrolls: body.scrollHeight > body.clientHeight + 1,
              hit: hit === back || back.contains(hit),
            };
          });
        const check = async () => {
          const now = await geometry();
          expect(now.pageHeight).toBeLessThanOrEqual(height);
          expect(now.pageWidth).toBeLessThanOrEqual(width);
          expect(now.sideways).toBe(false);
          // The calendar fills the available body rather than a short fixed-height crop.
          expect(now.surface.height).toBeGreaterThan(
            width === 1000 ? 480 : 240,
          );
          expect(now.surface.y + now.surface.height).toBeLessThanOrEqual(
            now.footer.y + 1,
          );
          expect(now.bodyScrolls).toBe(false);
          if (now.frame) {
            expect(now.frame.y).toBeGreaterThanOrEqual(now.surface.y);
            expect(now.frame.y + now.frame.height).toBeLessThanOrEqual(
              now.surface.y + now.surface.height,
            );
          }
          expect(now.hit).toBe(true);
          expect(Math.abs(now.titleY - now.railY)).toBeLessThanOrEqual(1);
          expect(now.body.y).toBeGreaterThanOrEqual(
            now.header.y + now.header.height - 1,
          );
          expect(now.body.y + now.body.height).toBeLessThanOrEqual(
            now.footer.y + 1,
          );
          expect(now.back.y + now.back.height).toBeLessThanOrEqual(height);
          // The calendar and its footer both stay inside the window.
          return now;
        };
        try {
          await routeCalendar(page, false);
          await open(page, "", cloudBuilt);
          await page.locator('label:has(input[value="business"])').click();
          await page
            .getByRole("button", { name: "Book a demo", exact: true })
            .click();
          await page
            .getByText("Loading available times…", { exact: true })
            .waitFor();
          await shot("loading");
          const initial = await check();
          expect(await page.evaluate(() => document.activeElement?.id)).toBe(
            "book-a-demo-title",
          );
          // Parent-origin and wrong-source messages must not mark the calendar ready.
          await page.evaluate(() => {
            window.postMessage(
              { event: "calendly.page_height", payload: { height: "1000px" } },
              "*",
            );
            window.dispatchEvent(
              new MessageEvent("message", {
                origin: "https://calendly.com",
                source: window,
                data: {
                  event: "calendly.page_height",
                  payload: { height: "1000px" },
                },
              }),
            );
          });
          await settled(page);
          expect(
            await page.locator(".booking-calendar[data-ready]").count(),
          ).toBe(0);
          const protocol = await page.evaluate(() => {
            const frame = document.querySelector<HTMLIFrameElement>(
              'iframe[title="Booking calendar"]',
            )!;
            const url = new URL(frame.src);
            return {
              origin: url.origin,
              path: url.pathname,
              embed: url.searchParams.get("embed_type"),
              domain: url.searchParams.get("embed_domain"),
              details: url.searchParams.get("hide_event_type_details"),
              gdpr: url.searchParams.get("hide_gdpr_banner"),
              sandbox: frame.getAttribute("sandbox"),
              referrer: frame.referrerPolicy,
            };
          });
          expect(protocol.origin).toBe("https://calendly.com");
          expect(protocol.path).toBe("/d/dwfr-k64-8d2/openbot-for-business");
          expect(protocol.embed).toBe("Inline");
          expect(protocol.domain).toBe("openbot.test");
          expect(protocol.details).toBe("1");
          expect(protocol.gdpr).toBe("1");
          expect(protocol.sandbox).toBe(
            "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
          );
          expect(protocol.referrer).toBe("strict-origin-when-cross-origin");
          await calendarMessage(page, "calendly.page_height", "26px");
          expect(
            await page.locator(".booking-calendar[data-ready]").count(),
          ).toBe(0);
          await shot("first-height");
          const first = await check();
          await calendarMessage(page, "calendly.event_type_viewed");
          await page.locator(".booking-calendar[data-ready]").waitFor();
          const viewed = await check();
          await calendarMessage(page, "calendly.page_height", "660px");
          await page.locator(".booking-calendar[data-ready]").waitFor();
          await page
            .getByText("Loading available times…", { exact: true })
            .waitFor({ state: "hidden" });
          await shot("ready");
          const ready = await check();
          await calendarMessage(page, "calendly.page_height", "1200px");
          const tall = await check();
          await page.evaluate(() =>
            document
              .querySelector('iframe[title="Booking calendar"]')!
              .dispatchEvent(new Event("error")),
          );
          await page
            .getByText(
              "Couldn't load the calendar. Book a demo opens it in your browser.",
              { exact: true },
            )
            .waitFor();
          await shot("fallback");
          const failed = await check();
          for (const now of [first, viewed, ready, tall, failed])
            for (const key of ["surface", "footer", "back"] as const)
              for (const dimension of ["x", "y", "width", "height"] as const)
                expect(
                  Math.abs(now[key][dimension] - initial[key][dimension]),
                ).toBeLessThanOrEqual(1);
          expect(
            await page.locator('iframe[title="Booking calendar"]').count(),
          ).toBe(0);
          expect(await page.evaluate(() => document.activeElement?.id)).toBe(
            "book-a-demo-title",
          );
          // Reach fallback and Back through the keyboard, starting from the focused heading.
          let reachedBack = false;
          let reachedFallback = false;
          for (let index = 0; index < 12; index++) {
            await page.keyboard.press("Tab");
            const focus = await page.evaluate(() => ({
              back: document.activeElement?.classList.contains("booking-back"),
              fallback:
                document.activeElement?.closest(".book-a-demo-fallback") !==
                null,
            }));
            if (focus.fallback) {
              reachedFallback = true;
              const link = await page.evaluate(() => {
                const element = document.activeElement as HTMLAnchorElement;
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                );
                return {
                  href: element.href,
                  hit: element === hit || element.contains(hit),
                };
              });
              expect(link).toEqual({
                href: "https://open.bot/business",
                hit: true,
              });
              await page.keyboard.press("Enter");
              expect(
                await page.evaluate(() => globalThis.__fake!.opened),
              ).toEqual(["https://open.bot/business"]);
            }
            if (focus.back) {
              reachedBack = true;
              break;
            }
          }
          expect(reachedFallback).toBe(true);
          expect(reachedBack).toBe(true);
          await check();
          await page.keyboard.press("Enter");
          await page.locator(".business-features").waitFor();
          expect(
            await page.evaluate(() => document.activeElement?.textContent),
          ).toBe("Book a demo");
        } finally {
          await page.close();
        }
      }, 30_000);

      test(`${width}x${height} ${colorScheme}: card embed retains reported height`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        try {
          await routeCalendar(page, false);
          await open(page, "#move-choice", cloudBuilt);
          await page.locator('label:has(input[value="business"])').click();
          await page.locator('iframe[title="Booking calendar"]').waitFor();
          const size = () =>
            page.evaluate(() => ({
              height: document
                .querySelector('iframe[title="Booking calendar"]')!
                .getBoundingClientRect().height,
              reserved: document.querySelectorAll(".setup-booking-surface")
                .length,
              pageHeight: document.documentElement.scrollHeight,
              pageWidth: document.documentElement.scrollWidth,
            }));
          expect((await size()).height).toBe(700);
          for (const reported of [660, 1100]) {
            await calendarMessage(
              page,
              "calendly.page_height",
              `${reported}px`,
            );
            await page.locator(".booking-calendar[data-ready]").waitFor();
            await settled(page);
            const now = await size();
            expect(now.height).toBe(reported);
            expect(now.reserved).toBe(0);
            expect(now.pageHeight).toBeLessThanOrEqual(height);
            expect(now.pageWidth).toBeLessThanOrEqual(width);
          }
        } finally {
          await page.close();
        }
      }, 30_000);
    }
});

/**
 * The Content Security Policy the shell serves the bundled window with (`app.security.csp`), as
 * directive name to sources. Tauri adds its own scripts' hashes to `script-src` when it serves the
 * page, so what is written here is the floor the window draws under.
 */
function bundledPolicy(): { text: string; directives: Map<string, string[]> } {
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ) as { app: { security: { csp: unknown } } };
  const text = config.app.security.csp;
  if (typeof text !== "string")
    throw new Error(
      `tauri.conf.json serves the window with no Content Security Policy (app.security.csp is ${JSON.stringify(text)})`,
    );
  const directives = new Map<string, string[]>();
  for (const part of text.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return { text, directives };
}

/*
 * Gemini takes an API key only. An installation whose saved connection is a Google sign-in opens on
 * the AI step, never Start: the step says the sign-in ended, and its one button opens Google
 * Gemini's API key, with no way to sign in to Google left on the row. In light and dark, wide and
 * at the window's smallest, the notice and its button are whole and in view.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each.
 */
describe.skipIf(!asked)("a saved Google sign-in for Gemini", () => {
  for (const colorScheme of ["light", "dark"] as const)
    for (const [width, height] of [
      [1000, 760],
      [760, 640],
    ] as const)
      test(`at ${width}x${height} (${colorScheme}), says it ended, and its button opens Gemini's API key`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        const shots = process.env.OPENBOT_APP_SHOTS;
        const shot = (name: string) =>
          shots
            ? page.screenshot({
                path: `${shots}/google-sign-in-ended-${name}-${colorScheme}-${width}.png`,
              })
            : Promise.resolve();
        try {
          await open(page, "#google-sign-in-ended");
          const notice = page.locator(".blocker", {
            hasText: "Google sign-in for Gemini has ended",
          });
          await notice.waitFor();
          await page.waitForTimeout(300);
          await shot("notice");
          expect(await notice.textContent()).toContain(
            "Add a Gemini API key to keep your Bots running on Gemini.",
          );
          const add = page.getByRole("button", {
            name: "Add a Gemini API key",
            exact: true,
          });
          const box = await add.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(box!.y + box!.height).toBeLessThanOrEqual(height);
          // Nothing started: the saved sign-in is never handed to Start.
          expect(await calls(page)).not.toContain("start_stack");
          await add.click();
          await page
            .getByLabel("Google Gemini API key", { exact: true })
            .waitFor();
          await page.waitForTimeout(300);
          await shot("key");
          expect(await notice.count()).toBe(0);
          expect(
            await page
              .getByRole("tab", { name: "Sign in", exact: true })
              .count(),
          ).toBe(0);
        } finally {
          await page.close();
        }
      });
});

describe("the bundled window's Content Security Policy", () => {
  test("loads only the window's own files, its images, the IPC and the booking calendar", () => {
    const { directives } = bundledPolicy();
    expect(directives.get("default-src")).toEqual(["'self'"]);
    // Nothing inline and nothing evaluated: Tauri adds its own scripts by hash.
    expect(directives.get("script-src")).toEqual(["'self'"]);
    // The shared orb is React's one inline stylesheet; allow only its exact contents.
    const orbHash = createHash("sha256").update(AGENT_ORB_CSS).digest("base64");
    expect(directives.get("style-src")).toEqual([
      "'self'",
      `'sha256-${orbHash}'`,
    ]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    // The one page the window frames is OpenBot for Business's booking calendar.
    expect(directives.get("frame-src")).toEqual([BOOKING_CALENDAR_ORIGIN]);
    // The window reaches the shell over Tauri's IPC only: `ipc:` on macOS and Linux, and
    // http://ipc.localhost on Windows.
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "ipc:",
      "http://ipc.localhost",
    ]);
  });
});

/**
 * The window served with that policy, as the shell serves it, collecting every violation the page
 * reports. A screen that needs something the policy refuses shows here as a violation.
 */
describe.skipIf(!asked)("the window under its Content Security Policy", () => {
  const RECORD_VIOLATIONS = `
    globalThis.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      globalThis.__violations.push(event.violatedDirective + " " + event.blockedURI);
    });
  `;
  const violations = (page: Page) =>
    page.evaluate(
      () => (globalThis as { __violations?: string[] }).__violations ?? [],
    );

  test("the first screen and OpenBot for Business's booking calendar draw with nothing refused", async () => {
    const { text } = bundledPolicy();
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await page.addInitScript(RECORD_VIOLATIONS);
      await routeCalendar(page);
      // An app's icon, as the move to OpenBot Cloud shows one from the app directory.
      await page.route("https://icons.openbot.test/**", (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
        }),
      );
      await open(page, "", built, { "Content-Security-Policy": text });
      await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
      await page
        .locator('label:has(input[value="business-own-cloud"])')
        .click();
      await page.locator(".tile-option.chosen").waitFor();
      await page.locator('label:has(input[value="business-cloud"])').click();
      await page
        .getByRole("button", { name: "Book a demo", exact: true })
        .click();
      await page
        .locator(
          '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
        )
        .waitFor();
      const icon = await page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = "https://icons.openbot.test/gmail.svg";
          }),
      );
      expect(icon).toBe(true);
      expect(await violations(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a script put into the page is refused", async () => {
    const { text } = bundledPolicy();
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await page.addInitScript(RECORD_VIOLATIONS);
      await open(page, "", built, { "Content-Security-Policy": text });
      await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
      const ran = await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "globalThis.__injected = true;";
        document.head.append(script);
        return (globalThis as { __injected?: boolean }).__injected === true;
      });
      expect(ran).toBe(false);
      await page.waitForTimeout(100);
      expect(await violations(page)).toContain("script-src-elem inline");
    } finally {
      await page.close();
    }
  });
});

/** Hold both startup phases so a one-frame legacy card cannot hide between them. */
describe.skipIf(!asked)("Cloud startup panel", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const)
    for (const colorScheme of ["light", "dark"] as const)
      test(`${width}x${height} ${colorScheme}: checking and opening retain the inset panel`, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          colorScheme,
        });
        try {
          await page.addInitScript(`
            let control;
            Object.defineProperty(globalThis, "__workbench", {
              configurable: true,
              get: () => control,
              set: (next) => {
                control = next;
                next.setAnswer("connection", { mode: "never" });
                next.setAnswer("show_connected", { mode: "never" });
              },
            });
          `);
          await open(page);
          await page
            .getByText("Checking your saved setup…", { exact: true })
            .waitFor();
          const geometry = () =>
            page.evaluate(() => {
              const pane = document.querySelector<HTMLElement>(
                "main > .rail + .launch-layout",
              )!;
              const box = pane.getBoundingClientRect();
              return {
                top: box.top,
                left: box.left,
                right: box.right,
                bottom: box.bottom,
                inset:
                  box.top >= 9 &&
                  box.right <= innerWidth - 9 &&
                  getComputedStyle(pane).borderTopWidth === "1px" &&
                  Number.parseFloat(getComputedStyle(pane).borderRadius) > 0,
                fits:
                  document.documentElement.scrollHeight <= innerHeight &&
                  document.documentElement.scrollWidth <= innerWidth,
                headings: document.querySelectorAll("h1").length,
              };
            });
          await settled(page);
          const checking = await geometry();
          expect(checking.inset).toBe(true);
          expect(checking.fits).toBe(true);
          expect(checking.headings).toBe(1);
          await page.evaluate(() =>
            globalThis.__workbench!.setAnswer("connection", {
              mode: "value",
              value: {
                mode: "connected",
                address: "https://api.open.bot",
                signedIn: true,
              },
            }),
          );
          await page.getByText("Opening OpenBot…", { exact: true }).waitFor();
          await settled(page);
          expect(await geometry()).toEqual(checking);
          if (process.env.OPENBOT_APP_SHOTS)
            await page.screenshot({
              path: `${process.env.OPENBOT_APP_SHOTS}/cloud-startup-${width}x${height}-${colorScheme}.png`,
            });
        } finally {
          await page.close();
        }
      });
});
