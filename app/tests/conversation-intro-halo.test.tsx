import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { ConversationIntro } from "../src/components/channels/conversation-intro";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../src/components/ui/message-scroller";
import { deploymentKeys } from "../src/lib/deployment/queries";

/**
 * The Bot's orb at the top of a conversation looks the same on the dark page as on the light one.
 *
 * Reported on 1.0.1 in the dark theme: the orb had a thin light ring around it, its halo was cut
 * flat with a hard edge, and a block of pixels sat around it, where the light theme looked fine.
 * The ring was the avatar's outline, left floating off a disc that idles at 94% of its box. The
 * hard edge was the transcript's scroller: in the desktop's default window the column gives the orb
 * a 16px gutter, and the halo reaches 40px. The pixels were the halo's pattern, which stood out far
 * more on the dark page, and showed through the disc where its mesh is clear.
 *
 * Rendered in a real Chromium, because what is cut and what is drawn is the browser's to decide. The
 * markup is the real intro inside the transcript's scroller, column and all, as ChatTranscript lays
 * it out, and the stylesheet is Tailwind's build of the app's own stylesheet for those classes.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/conversation-intro-halo.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");

/** ChatTranscript's column: centred, 768px at most, with a 16px gutter. */
const COLUMN = "mx-auto w-full max-w-3xl px-4";

const bot = {
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday Work",
  roleDescription: "Help with everyday work.",
  avatarSeed: "general-assistant",
  visibility: "private" as const,
};

function markup(): string {
  const client = new QueryClient();
  client.setQueryData(deploymentKeys.capabilities(), { edition: "personal" });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <div className="flex h-svh bg-background">
        <MessageScrollerProvider>
          <MessageScroller className="@container">
            <MessageScrollerViewport>
              <MessageScrollerContent className={`py-6 ${COLUMN}`}>
                <ConversationIntro agent={bot} />
                <p>Hello there.</p>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </QueryClientProvider>,
  );
}

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for the intro's classes, as the app's build does. */
async function stylesheet(page: string): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const classes = [...page.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    (match[1] ?? "").split(/\s+/).filter(Boolean),
  );
  return compiler.build(classes);
}

let browser: Browser;
let page: string;
let css: string;

beforeAll(async () => {
  if (!asked) return;
  page = markup();
  css = await stylesheet(page);
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

type Theme = "light" | "dark";

/** The conversation in a pane this wide, in this theme. */
async function open(width: number, theme: Theme): Promise<Page> {
  const tab = await browser.newPage({
    viewport: { width, height: 600 },
    reducedMotion: "reduce",
  });
  await tab.setContent(
    `<!doctype html><html class="${theme}"><head><style>${css}</style></head><body>${page}</body></html>`,
  );
  return tab;
}

type Box = { top: number; right: number; bottom: number; left: number };

/**
 * Where the halo paints, and where it can be seen. The halo is the pattern's box (its mask is gone
 * by the box's edge) and the orb's glow, whose box is blurred outward by the blur's radius. It can
 * be seen inside the window and inside every ancestor that clips what overflows it.
 */
async function halo(tab: Page) {
  return tab.evaluate(() => {
    const box = (element: Element) => {
      const { top, right, bottom, left } = element.getBoundingClientRect();
      return { top, right, bottom, left };
    };
    const pattern = document.querySelector(".orb-pattern");
    const disc = document.querySelector(".bot-orb-live .agent-orb");
    const glow = disc?.previousElementSibling;
    if (!pattern || !disc || !glow) throw new Error("No orb in the intro");
    const blur = Number.parseFloat(
      /blur\(([\d.]+)px\)/.exec(getComputedStyle(glow).filter)?.[1] ?? "0",
    );
    const bloom = box(glow);
    const painted = [
      box(pattern),
      {
        top: bloom.top - blur,
        right: bloom.right + blur,
        bottom: bloom.bottom + blur,
        left: bloom.left - blur,
      },
    ].reduce((all, one) => ({
      top: Math.min(all.top, one.top),
      right: Math.max(all.right, one.right),
      bottom: Math.max(all.bottom, one.bottom),
      left: Math.min(all.left, one.left),
    }));
    const visible = {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    };
    for (let at = pattern.parentElement; at; at = at.parentElement) {
      if (at === document.body) break;
      const { overflowX, overflowY, contain } = getComputedStyle(at);
      const paints = /paint|content|strict/.test(contain);
      const edge = box(at);
      if (paints || overflowY !== "visible") {
        visible.top = Math.max(visible.top, edge.top);
        visible.bottom = Math.min(visible.bottom, edge.bottom);
      }
      if (paints || overflowX !== "visible") {
        visible.left = Math.max(visible.left, edge.left);
        visible.right = Math.min(visible.right, edge.right);
      }
    }
    return { painted, visible };
  });
}

const inside = (painted: Box, visible: Box) => ({
  top: painted.top >= visible.top,
  right: painted.right <= visible.right,
  bottom: painted.bottom <= visible.bottom,
  left: painted.left >= visible.left,
});
const whole = { top: true, right: true, bottom: true, left: true };

/** How the orb is drawn: its outline, the disc's ground, and the halo's pattern against the page. */
async function drawn(tab: Page) {
  return tab.evaluate(() => {
    const wrapper = document.querySelector(".bot-orb-live");
    const disc = wrapper?.querySelector(".agent-orb");
    const pattern = document.querySelector(".orb-pattern");
    if (!wrapper || !disc || !pattern) throw new Error("No orb in the intro");
    // Resolved to rgb by drawing each color on a canvas, so oklch and rgb compare alike.
    const canvas = document.createElement("canvas").getContext("2d");
    const rgb = (color: string) => {
      if (!canvas) throw new Error("No canvas");
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    // Perceived lightness: the cube root of luminance, as OKLab's L is.
    const lightness = (color: string) => {
      const [r, g, b] = rgb(color).map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return Math.cbrt(0.2126 * r + 0.7152 * g + 0.0722 * b);
    };
    const page = getComputedStyle(
      document.body.firstElementChild as Element,
    ).backgroundColor;
    const shown = getComputedStyle(pattern);
    // Every shadow on the wrapper, less the transparent ones Tailwind keeps in its stack.
    const outlines = getComputedStyle(wrapper)
      .boxShadow.split(/,(?![^(]*\))/)
      .map((shadow) => shadow.trim())
      .filter((shadow) => {
        const color = /^(\w+\([^)]*\)|#\w+|\w+)/.exec(shadow)?.[1];
        return shadow !== "none" && color !== undefined && rgb(color)[3] > 0;
      });
    return {
      outlines,
      ground: rgb(getComputedStyle(disc).backgroundColor),
      halo:
        Number(shown.opacity) *
        Math.abs(lightness(shown.backgroundColor) - lightness(page)),
    };
  });
}

const panes = [
  { name: "the desktop's default window", width: 650 },
  { name: "the narrowest window", width: 370 },
  { name: "a wide window", width: 1100 },
];

describe.skipIf(!asked)("the Bot's orb at the top of a conversation", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const pane of panes) {
      test(`${theme}, in ${pane.name} (${pane.width}px): the halo is drawn whole`, async () => {
        const tab = await open(pane.width, theme);
        try {
          const { painted, visible } = await halo(tab);
          expect(inside(painted, visible)).toEqual(whole);
        } finally {
          await tab.close();
        }
      });
    }
  }

  test("has no outline in either theme", async () => {
    for (const theme of ["light", "dark"] as const) {
      const tab = await open(650, theme);
      try {
        expect({ theme, outlines: (await drawn(tab)).outlines }).toEqual({
          theme,
          outlines: [],
        });
      } finally {
        await tab.close();
      }
    }
  });

  test("the disc stands on the same opaque ground in both themes", async () => {
    const grounds: number[][] = [];
    for (const theme of ["light", "dark"] as const) {
      const tab = await open(650, theme);
      try {
        grounds.push((await drawn(tab)).ground);
      } finally {
        await tab.close();
      }
    }
    expect(grounds[0][3]).toBe(255);
    expect(grounds[1]).toEqual(grounds[0]);
  });

  test("the halo's pattern stands out no more on the dark page than on the light one", async () => {
    const strength: Record<Theme, number> = { light: 0, dark: 0 };
    for (const theme of ["light", "dark"] as const) {
      const tab = await open(650, theme);
      try {
        strength[theme] = (await drawn(tab)).halo;
      } finally {
        await tab.close();
      }
    }
    expect(strength.light).toBeGreaterThan(0);
    // Within the rounding of 8-bit color; before the fix the dark one was 1.6 times as strong.
    expect(strength.dark).toBeLessThanOrEqual(strength.light * 1.05);
  });
});
