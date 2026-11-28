import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page, Request } from "playwright-core";
import {
  alerts,
  asked,
  cutOff,
  engines,
  FakeServer,
  type Look,
  open,
  shoot,
  start,
  stop,
  style,
} from "./organization-notices-browser";

/**
 * On OpenBot Cloud the release the server runs is on screen on every page, under the strip's avatar,
 * so a screenshot sent with a bug report says which release it was taken on.
 *
 * Reported from Cloud: since the strip, the version showed only inside the account menu, and no
 * screenshot of a page carried it.
 *
 * In a real browser, Chromium and WebKit, light and dark: at 1440 and 800 wide, where the strip is
 * on screen, and at 390, where it is in the sheet the sidebar button opens. The app is the real
 * signed-in gate and frame (organization-notices.fixture.tsx) on a server that answers as Cloud
 * (`hostedSignIn`). A build's long `main-20261113-9` and a commit's `internal-6e5f485bc71c` wrap
 * inside the strip, whole, under the avatar and clear of it; a release's `v1.2.0` sits on one line.
 * A server that isn't Cloud draws no version on the strip.
 *
 * Found while building it: wrapped as `wrap-break-word`, the strip's foot grew to fit `20261113-`,
 * which is wider than the strip, and the date ran 1px past both of its edges.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/strip-version-layout.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each page is saved as strip-version-<state>-<engine>-<width>-<theme>.png,
 * and the strip's foot alone as strip-version-<state>-foot-<engine>-<width>-<theme>.png.
 */

/** The desktop width, a narrow window that still shows the strip, and a phone's, light and dark. */
const LOOKS: readonly Look[] = [
  { width: 1440, height: 900, theme: "light" },
  { width: 1440, height: 900, theme: "dark" },
  { width: 800, height: 700, theme: "light" },
  { width: 800, height: 700, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
];

/** A build's, a commit's and a release's, as the server names them and as the strip shows them. */
const VERSIONS = [
  ["cloud-build", "main-20261113-9", "main-20261113-9"],
  ["cloud-commit", "internal-6e5f485bc71c", "internal-6e5f485bc71c"],
  ["cloud-release", "1.2.0", "v1.2.0"],
] as const;

/** A server that answers as Cloud or not, running `version`. */
class VersionServer extends FakeServer {
  constructor(
    readonly cloud: boolean,
    readonly version: string,
  ) {
    super();
  }

  override answer(request: Request) {
    const answer = super.answer(request);
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/deployment"))
      return {
        ...answer,
        json: { ...(answer.json as object), hostedSignIn: this.cloud },
      };
    if (path.endsWith("/people/me") && answer.status === 200)
      return {
        ...answer,
        json: { ...(answer.json as object), openbotVersion: this.version },
      };
    return answer;
  }
}

/** The strip as the window shows it: in the sheet at a phone's width, which the person opens. */
async function showStrip(page: Page, look: Look): Promise<void> {
  if (look.width < 768) {
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await page.getByRole("dialog").waitFor();
  }
  await page.locator('[data-slot="strip"]').last().waitFor();
  // What the sheet brings is styled as the rest of the page was.
  await style(page);
}

/**
 * How the strip sits, and the version on it against the strip and the avatar above it: its width
 * and the avatar's middle, which the version must not move sideways, and the version's lines.
 */
async function measured(page: Page) {
  return page.evaluate(() => {
    const strips = [...document.querySelectorAll('[data-slot="strip"]')];
    const strip = strips.find((one) => one.getBoundingClientRect().width > 0);
    if (!strip) throw new Error("no strip on screen");
    const avatar = strip.querySelector<HTMLElement>(
      "button[aria-haspopup]",
    ) as HTMLElement;
    const box = strip.getBoundingClientRect();
    const face = avatar.getBoundingClientRect();
    const frame = {
      stripWidth: box.width,
      avatarMiddle: (face.left + face.right) / 2,
    };
    const version = strip.querySelector<HTMLElement>(
      '[data-slot="openbot-version"]',
    );
    if (!version) return { ...frame, text: null };
    const words = document.createRange();
    words.selectNodeContents(version);
    // Each line's own box, so a line that runs past the strip is caught even when the element isn't.
    const lines = [...words.getClientRects()];
    const text = words.getBoundingClientRect();
    return {
      ...frame,
      text: version.textContent,
      lines: new Set(lines.map((line) => Math.round(line.top))).size,
      cut: version.scrollWidth > version.clientWidth,
      inside: lines.every(
        (line) =>
          line.left >= box.left - 0.5 &&
          line.right <= box.right + 0.5 &&
          line.bottom <= box.bottom + 0.5,
      ),
      underAvatar: text.top >= face.bottom - 0.5,
      fontSize: getComputedStyle(version).fontSize,
      centred: Math.abs(
        (text.left + text.right) / 2 - (box.left + box.right) / 2,
      ),
    };
  });
}

beforeAll(async () => {
  if (asked) await start();
}, 120_000);

afterAll(async () => {
  await stop();
});

/** The strip's width and the avatar's middle where there is no version, by engine and look. */
const unchanged = new Map<
  string,
  { stripWidth: number; avatarMiddle: number }
>();

describe.skipIf(!asked)("the version on the strip", () => {
  // First, so each Cloud test below has the strip as it is with no version to compare with.
  for (const engine of engines)
    for (const look of LOOKS) {
      test(`not on Cloud, the strip shows no version, in ${engine}, ${look.width}, ${look.theme}`, async () => {
        const page = await open(
          engine,
          look,
          new VersionServer(false, "1.2.0"),
          "/routines",
        );
        try {
          await page.getByRole("heading", { name: "Routines" }).waitFor();
          await shoot(page, "strip-version", "not-cloud", engine, look);
          await showStrip(page, look);
          await shootFoot(page, "not-cloud", engine, look);
          const { text, stripWidth, avatarMiddle } = await measured(page);
          expect(text).toBeNull();
          unchanged.set(`${engine} ${look.width} ${look.theme}`, {
            stripWidth,
            avatarMiddle,
          });
        } finally {
          await page.close();
        }
      }, 60_000);
    }

  for (const engine of engines)
    for (const look of LOOKS)
      for (const [state, version, shown] of VERSIONS) {
        test(`on Cloud, ${shown} reads whole under the avatar, in ${engine}, ${look.width}, ${look.theme}`, async () => {
          const page = await open(
            engine,
            look,
            new VersionServer(true, version),
            "/routines",
          );
          try {
            await page.getByRole("heading", { name: "Routines" }).waitFor();
            await shoot(page, "strip-version", state, engine, look);
            await showStrip(page, look);
            await shootFoot(page, state, engine, look);
            const sits = await measured(page);
            expect(sits).toMatchObject({
              text: shown,
              cut: false,
              inside: true,
              underAvatar: true,
              fontSize: "10px",
            });
            if (!("lines" in sits)) throw new Error("no version on the strip");
            expect(sits.centred).toBeLessThanOrEqual(1);
            // A release on one line; a build's or a commit's on no more than three.
            expect(sits.lines).toBeLessThanOrEqual(
              state === "cloud-release" ? 1 : 3,
            );
            /*
             * The strip keeps its width and the avatar its place across. Found while building it:
             * in a phone's sheet the strip is as wide as what it holds, and a build's version on
             * one line made it 84px wide in place of 48, pushing the panel beside it over.
             */
            const before = unchanged.get(
              `${engine} ${look.width} ${look.theme}`,
            );
            expect(before).toBeDefined();
            expect(sits.stripWidth).toBeCloseTo(before?.stripWidth ?? 0, 1);
            expect(sits.avatarMiddle).toBeCloseTo(before?.avatarMiddle ?? 0, 1);
            expect(await alerts(page)).toEqual([]);
            expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });
          } finally {
            await page.close();
          }
        }, 60_000);
      }
});

/** The strip's foot alone, with the page's edge beside it, when screenshots are asked for. */
async function shootFoot(
  page: Page,
  state: string,
  engine: string,
  look: Look,
): Promise<void> {
  const shots = process.env.OPENBOT_APP_SHOTS;
  if (!shots) return;
  const box = await page.evaluate(() => {
    const strip = [...document.querySelectorAll('[data-slot="strip"]')].find(
      (one) => one.getBoundingClientRect().width > 0,
    );
    const rect = strip?.getBoundingClientRect();
    return rect
      ? { x: rect.left, y: rect.bottom, width: rect.width }
      : undefined;
  });
  if (!box) return;
  const height = 180;
  await page.screenshot({
    path: `${shots}/strip-version-${state}-foot-${engine}-${look.width}-${look.theme}.png`,
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y - height),
      width: box.width + 160,
      height,
    },
    scale: "device",
  });
}
