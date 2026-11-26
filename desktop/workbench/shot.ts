// Captures one current view. Links carry route and overrides; there is no scripted replay.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Browser,
  type Chromium,
  nextFrame,
  PLAYWRIGHT,
  readPageReport,
} from "./cliPage";
import { COMMANDS } from "../src/fakeNative/registry";
import { PAGE_COMMANDS } from "../src/fakeNative/pageRegistry";
import { loadScenesInBun } from "./sceneCatalog";
import { ensureServer } from "./server";
import { DEFAULT_WINDOW, decodeState, encodeState } from "./urlState";

const USAGE =
  "Usage: bun run desktop-workbench:shot [preset] [--url <workbench-link>] [--route </path>] [--size <w>x<h>] [--os mac|windows] [--theme light|dark] [--host desktop|browser] [--role member|admin|owner] [--skin <skin>] [--sidebar open|closed] [--grid] [--out <dir>]";
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const catalog = await loadScenesInBun();
  const params = new URLSearchParams();
  let link: URL | null = null;
  let out = resolve("workbench-shots");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const text = argv[++i];
      if (!text || text.startsWith("--")) throw new Error(USAGE);
      return text;
    };
    if (arg === "--url") link = new URL(value());
    else if (arg === "--out") out = resolve(value());
    else if (arg === "--grid") params.set("grid", "1");
    else if (arg === "--size") {
      const match = /^(\d+)x(\d+)$/.exec(value());
      if (!match) throw new Error(USAGE);
      params.set("w", match[1] as string);
      params.set("h", match[2] as string);
    } else if (
      [
        "--route",
        "--os",
        "--theme",
        "--host",
        "--role",
        "--skin",
        "--sidebar",
      ].includes(arg ?? "")
    )
      params.set((arg as string).slice(2), value());
    else if (arg?.startsWith("--") || params.has("scene"))
      throw new Error(USAGE);
    else if (arg) params.set("scene", arg);
  }
  const query = new URLSearchParams(link?.search);
  for (const [key, value] of params) query.set(key, value);
  const decoded = decodeState(query.toString(), catalog.scenes, [
    ...COMMANDS,
    ...PAGE_COMMANDS,
  ]);
  if (decoded.notices.length) throw new Error(decoded.notices.join("\n"));
  // Viewer scale is one for the export; the iframe keeps the chosen logical size.
  decoded.state.window.zoom = DEFAULT_WINDOW.zoom;
  mkdirSync(out, { recursive: true });
  const server = await ensureServer();
  let browser: Browser | undefined;
  try {
    const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
    browser = await chromium.launch({ channel: "chromium" });
    const page = await browser.newPage({
      viewport: {
        width: decoded.state.window.width + 640,
        height: decoded.state.window.height + 400,
      },
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC",
    });
    await page.goto(`${server.url}/workbench/?${encodeState(decoded.state)}`);
    await page.waitForFunction(() => window.__workbenchPage?.ready === true);
    await nextFrame(page);
    const path = resolve(out, decoded.state.scene);
    await page
      .locator("[data-workbench-window]")
      .screenshot({ path: `${path}.png` });
    await Bun.write(
      `${path}.json`,
      `${JSON.stringify(await readPageReport(page), null, 2)}\n`,
    );
    console.log(`${path}.png`);
    console.log(`${path}.json`);
  } finally {
    await browser?.close();
    await server.stop();
  }
}
if (import.meta.main)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
