import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Browser, Page } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { BotLookProvider } from "../src/components/agents/bot-look";
import { ChannelItemContent } from "../src/components/app-sidebar/channel-item-content";
import { BotProfileHeader } from "../src/components/bot-profile/profile";
import { ConversationIntro } from "../src/components/channels/conversation-intro";
import { agentListQueryOptions } from "../src/lib/agents/queries";
import { deploymentKeys } from "../src/lib/deployment/queries";
import { ORB_PALETTES, orbPalette } from "../src/lib/orb-palette";

/**
 * A Bot's orb is one color wherever it is drawn: in the sidebar, at the top of its own page and at
 * the top of a conversation with it.
 *
 * Seen on Windows with the Personal Assistant: its orb was green in the sidebar, the Bots list and
 * the command menu, and blue, teal and pink at the top of its page and of its conversation. Both
 * came from the same palette, drawn two ways: at avatar sizes a still orb, the palette's lightest
 * stop lit through its second to its third at the rim; larger, the live orb, a mesh in which the
 * third, a violet, lay across the top. A person read them as two Bots.
 *
 * Rendered in a real Chromium, because the color a person sees is the browser's to draw. The
 * markup is the real sidebar row, page header and conversation intro, and the stylesheet is
 * Tailwind's build of the app's own stylesheet for their classes. Each orb's color is the mean of
 * the pixels inside its disc, compared in OKLab, where a distance reads as a difference a person
 * sees.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/bot-orb-one-color.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");

/** One Bot for each of the eight palettes, the Personal Assistant's first. */
const BOTS = ORB_PALETTES.map((palette, index) => {
  const seed =
    index === 0
      ? "personal-assistant"
      : Array.from({ length: 400 }, (_, n) => `bot-${n}`).find(
          (candidate) => orbPalette(candidate) === palette,
        );
  if (!seed || orbPalette(seed) !== palette)
    throw new Error(`no seed for palette ${index}`);
  return {
    id: seed,
    name: `Bot ${index}`,
    title: "Everyday life",
    roleDescription: "Help with email, your calendar and everyday errands.",
    avatarSeed: seed,
    visibility: "private" as const,
  };
});

type Bot = (typeof BOTS)[number];

/** Where a Bot's orb is drawn, as each place draws it. */
const SURFACES = {
  "the sidebar": (bot: Bot) => (
    <ChannelItemContent
      emphasis="agent"
      name={bot.name}
      participantIds={[bot.id]}
      title="Multiplying 17 by 23"
    />
  ),
  "its page": (bot: Bot) => <BotProfileHeader agent={bot} />,
  "its conversation": (bot: Bot) => <ConversationIntro agent={bot} />,
};
type Surface = keyof typeof SURFACES;

function markup(): string {
  const client = new QueryClient();
  client.setQueryData(agentListQueryOptions().queryKey, BOTS as never);
  client.setQueryData(deploymentKeys.capabilities(), { edition: "personal" });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {/* OpenBot's own look, where Bots are orbs. */}
      <BotLookProvider value="orb">
        <div className="flex flex-col gap-16 bg-background p-16">
          {BOTS.map((bot) =>
            Object.entries(SURFACES).map(([surface, draw]) => (
              <div data-bot={bot.id} data-surface={surface} key={surface}>
                {draw(bot)}
              </div>
            )),
          )}
        </div>
      </BotLookProvider>
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

/** The app's stylesheet, built by Tailwind for the page's classes, as the app's build does. */
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
type Lab = [number, number, number];

/** Every orb on the page, in this theme, still as reduced motion holds it. */
async function open(theme: Theme): Promise<Page> {
  const tab = await browser.newPage({
    viewport: { width: 900, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  await tab.setContent(
    `<!doctype html><html class="${theme}"><head><style>${css}</style></head><body>${page}</body></html>`,
  );
  return tab;
}

/**
 * The color a person sees in a Bot's orb on this surface: the mean of the pixels inside the middle
 * three quarters of its disc, in OKLab. The disc's rim and the glow around it are left out.
 */
async function colorOf(tab: Page, bot: Bot, surface: Surface): Promise<Lab> {
  const orb = tab.locator(
    `[data-bot="${bot.id}"][data-surface="${surface}"] [role="img"][data-variant]`,
  );
  const shot = (await orb.screenshot()).toString("base64");
  return tab.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas");
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(
      0,
      0,
      image.width,
      image.height,
    );
    const linear = (channel: number) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const radius = (Math.min(width, height) / 2) * 0.75;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) > radius)
          continue;
        const at = (y * width + x) * 4;
        r += linear(data[at]);
        g += linear(data[at + 1]);
        b += linear(data[at + 2]);
        n++;
      }
    }
    [r, g, b] = [r / n, g / n, b / n];
    // Linear sRGB to OKLab (https://bottosson.github.io/posts/oklab/).
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ] as [number, number, number];
  }, shot);
}

/** How far apart two colors are, in OKLab, ×100: about 2 is the least a person notices side by side. */
const distance = (one: Lab, other: Lab) =>
  100 * Math.hypot(one[0] - other[0], one[1] - other[1], one[2] - other[2]);

/** The angle between two colors' hues, in degrees. */
const hueApart = (one: Lab, other: Lab) => {
  const degrees = (lab: Lab) => (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  const apart = Math.abs(degrees(one) - degrees(other)) % 360;
  return Math.min(apart, 360 - apart);
};

/**
 * As far apart as one Bot's orb may be between places, and as far as its hue may turn. The larger
 * orbs have a rim, a sheen and a halftone the still one does not, so they are close, not identical:
 * drawn as one sphere, every palette is within about 4 apart and 5° of its sidebar orb. Drawn two
 * ways, the Personal Assistant's was 11 apart with its hue turned 47°, and the furthest 17 and 116°.
 */
const MOST_APART = 8;
const MOST_TURNED = 10;

describe.skipIf(!asked)("a Bot's orb is one color everywhere", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: at the top of its page and of its conversation, as in the sidebar`, async () => {
      const tab = await open(theme);
      try {
        const apart: string[] = [];
        for (const bot of BOTS) {
          const sidebar = await colorOf(tab, bot, "the sidebar");
          for (const surface of ["its page", "its conversation"] as const) {
            const here = await colorOf(tab, bot, surface);
            const far = distance(sidebar, here);
            const turned = hueApart(sidebar, here);
            if (far > MOST_APART || turned > MOST_TURNED)
              apart.push(
                `${bot.name} (palette ${BOTS.indexOf(bot)}) on ${surface}: ${far.toFixed(1)} apart, hue turned ${turned.toFixed(0)}°`,
              );
          }
        }
        expect(apart).toEqual([]);
      } finally {
        await tab.close();
      }
    }, 60_000);
  }
});
