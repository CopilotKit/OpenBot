import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Browser, BrowserType } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { BotLookProvider } from "../src/components/agents/bot-look";
import { ChannelItemContent } from "../src/components/app-sidebar/channel-item-content";
import { agentListQueryOptions } from "../src/lib/agents/queries";
import { deploymentKeys } from "../src/lib/deployment/queries";

/**
 * A compact conversation row's orbs sit whole inside their avatar.
 *
 * Seen in the sidebar's compact rows: a group conversation's two orbs were cut across the bottom,
 * so they read as two flat ovals. At the compact row's 20px avatar each orb is 12px, smaller than
 * the row's line, and an orb is an inline block: it sat on the line's baseline, 4px below the top
 * of the circle that clips it. At the detailed row's 32px the orbs are taller than the line and it
 * never showed.
 *
 * Rendered in a real Chromium and WebKit, because where an inline block sits on a line is the
 * browser's layout to decide. The markup is the real row, compact and detailed, with one Bot and
 * with two, and the stylesheet is Tailwind's build of the app's own stylesheet for its classes.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/compact-avatar-layout.test.tsx
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

const APP = join(import.meta.dir, "..");

const BOTS = [
  { id: "travel", name: "Travel Planner", avatarSeed: "travel" },
  { id: "finance", name: "Finance Analyst", avatarSeed: "finance" },
];

const ROWS = {
  "compact, one Bot": { view: "compact", ids: ["travel"] },
  "compact, two Bots": { view: "compact", ids: ["travel", "finance"] },
  "detailed, one Bot": { view: "detailed", ids: ["travel"] },
  "detailed, two Bots": { view: "detailed", ids: ["travel", "finance"] },
} as const;
type Row = keyof typeof ROWS;

function markup(): string {
  const client = new QueryClient();
  client.setQueryData(agentListQueryOptions().queryKey, BOTS as never);
  client.setQueryData(deploymentKeys.capabilities(), { edition: "personal" });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {/* OpenBot's own look, where Bots are orbs. */}
      <BotLookProvider value="orb">
        <div className="flex w-80 flex-col gap-4 bg-sidebar p-4">
          {Object.entries(ROWS).map(([row, { view, ids }]) => (
            <div className="flex" data-row={row} key={row}>
              <ChannelItemContent
                emphasis="thread"
                lastMessageAt="2h"
                name="Travel Planner, Finance Analyst"
                participantIds={[...ids]}
                title="A three-day team offsite in Lisbon"
                view={view}
              />
            </div>
          ))}
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

let engines: [string, Browser][] = [];
let page: string;
let css: string;

beforeAll(async () => {
  if (!asked) return;
  page = markup();
  css = await stylesheet(page);
  const { chromium, webkit } = await import("playwright-core");
  engines = [
    // The CI job installs full Chromium without the headless shell.
    ["chromium", await chromium.launch({ channel: "chromium" })],
  ];
  if ((process.env.OPENBOT_APP_ENGINES ?? "").includes("webkit"))
    engines.push(["webkit", await (webkit as BrowserType).launch()]);
});

afterAll(async () => {
  for (const [, browser] of engines) await browser.close();
});

/**
 * How far each orb in a row sits from the square or circle that holds it, in CSS pixels: 0 when it
 * fills it exactly. The avatar's own square for one Bot, each orb's clipping circle for a group.
 */
async function offsets(browser: Browser): Promise<Record<Row, number[]>> {
  const tab = await browser.newPage({ viewport: { width: 400, height: 600 } });
  try {
    await tab.setContent(
      `<!doctype html><html class="light"><head><style>${css}</style></head><body>${page}</body></html>`,
    );
    return await tab.evaluate((rows) => {
      const out: Record<string, number[]> = {};
      for (const row of rows) {
        const orbs = document.querySelectorAll<HTMLElement>(
          `[data-row="${row}"] .bot-orb-still`,
        );
        out[row] = [...orbs].map((orb) => {
          const holder = orb.closest<HTMLElement>(
            ".overflow-hidden, .relative",
          );
          if (!holder) return Number.NaN;
          const a = orb.getBoundingClientRect();
          const b = holder.getBoundingClientRect();
          return Math.max(
            Math.abs(a.top - b.top),
            Math.abs(a.left - b.left),
            Math.abs(a.bottom - b.bottom),
            Math.abs(a.right - b.right),
          );
        });
      }
      return out;
    }, Object.keys(ROWS));
  } finally {
    await tab.close();
  }
}

describe.skipIf(!asked)(
  "a conversation row's orbs sit whole in their avatar",
  () => {
    test("compact and detailed, one Bot and two, in every engine", async () => {
      for (const [engine, browser] of engines) {
        const found = await offsets(browser);
        for (const row of Object.keys(ROWS) as Row[]) {
          expect({ engine, row, count: found[row].length }).toEqual({
            engine,
            row,
            count: ROWS[row].ids.length,
          });
          for (const off of found[row])
            expect({ engine, row, off: Math.round(off * 10) / 10 }).toEqual({
              engine,
              row,
              off: 0,
            });
        }
      }
    }, 60_000);
  },
);
