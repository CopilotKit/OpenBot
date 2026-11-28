import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";

/**
 * A picture over 8MB is not downloaded to draw its tile; it is fetched when somebody opens it.
 *
 * Pictures go up to 100MB on an install with an object store. A tile that draws one as a thumbnail
 * fetches all of it, for every reader, the moment the conversation paints, and on a slow link that
 * download holds up the conversation's other requests. Over the old 8MB image limit the tile is the
 * file instead (name, kind, size, Open and Download), and the full picture is fetched only when it
 * is opened in the lightbox. A picture of 8MB or less draws as it always did.
 *
 * Counted on the wire, in a real Chromium, because what a browser fetches for an `<img>` is the
 * browser's decision. The transcript is the real component, bundled from the fixture beside this
 * file, with the app's own stylesheet.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/large-picture-tile.test.tsx
 *
 * `OPENBOT_SHOTS=<dir>` also saves the tiles light and dark, wide and on a phone, and the lightbox.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const BIG = "/api/v2/organizations/default/attachments/big";
const SMALL = "/api/v2/organizations/default/attachments/small";

/** A real picture to serve for either file: a 240px sky over grass. */
function picture(): Buffer {
  const side = 240;
  const row = side * 3 + 1;
  const raw = Buffer.alloc(row * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sky = y < side * 0.65;
      raw.set(
        sky ? [90 + y / 3, 160, 235] : [50, 125, 70],
        y * row + 1 + x * 3,
      );
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of typed) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "large-picture-tile.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "no-marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "no-marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
            contents: "export const markFor = () => null;",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package for ${id}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
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
  return compiler.build(classes);
}

let browser: Browser;
let script: string;
let css = "";
const bytes = picture();

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const { chromium } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
  // A first pass, closed and open, to know which classes the stylesheet needs.
  const { page } = await open();
  try {
    const classes = new Set(await classesOn(page));
    await page.getByRole("button", { name: "Open drone-survey.png" }).click();
    await page.getByRole("dialog").waitFor();
    for (const name of await classesOn(page)) classes.add(name);
    css = await stylesheet([...classes]);
  } finally {
    await page.close();
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** The conversation, with every request for a file counted by its address. */
async function open(
  theme: "light" | "dark" = "light",
  viewport = { width: 1000, height: 700 },
): Promise<{ page: Page; fetched: string[] }> {
  const page = await browser.newPage({ viewport });
  const fetched: string[] = [];
  page.on("pageerror", (error) => console.error(error));
  await page.route(`${ORIGIN}/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/transcript.js"></script></body></html>`,
      });
    if (path === "/transcript.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === BIG || path === SMALL) {
      fetched.push(`${request.method()} ${path}`);
      return route.fulfill({ contentType: "image/png", body: bytes });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?theme=${theme}`);
  await page.getByText("Here is the drone survey").waitFor({ timeout: 8000 });
  return { page, fetched };
}

function classesOn(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [
        ...element.classList,
      ]),
    ),
  ]);
}

/** Every picture on the page has finished, drawn or not, so the count is final. */
async function settled(page: Page) {
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  await still(page);
}

test.skipIf(!asked)(
  "a picture over 8MB is not fetched until it is opened, and opens full size",
  async () => {
    const { page, fetched } = await open();
    try {
      await settled(page);
      // The small picture is drawn; the large one is its file, and nothing asked for its bytes.
      expect(fetched).toEqual([`GET ${SMALL}`]);
      await page.getByText("PNG image · 95 MB").waitFor();

      await page.getByRole("button", { name: "Open drone-survey.png" }).click();
      const opened = page
        .getByRole("dialog")
        .getByRole("img", { name: "drone-survey.png" });
      await opened.waitFor();
      await settled(page);
      expect(
        await opened.evaluate(
          (image) => (image as HTMLImageElement).naturalWidth,
        ),
      ).toBe(240);
      expect(fetched).toEqual([`GET ${SMALL}`, `GET ${BIG}`]);
    } finally {
      await page.close();
    }
  },
  30_000,
);

test.skipIf(!asked || !shots)(
  "the tiles, light and dark, wide and on a phone",
  async () => {
    for (const theme of ["light", "dark"] as const) {
      for (const [shape, viewport] of [
        ["desktop", { width: 1000, height: 700 }],
        ["phone", { width: 390, height: 844 }],
      ] as const) {
        const { page } = await open(theme, viewport);
        try {
          await settled(page);
          await page.screenshot({
            path: `${shots}/large-picture-tile-${theme}-${shape}.png`,
          });
          await page
            .getByRole("button", { name: "Open drone-survey.png" })
            .click();
          await page
            .getByRole("dialog")
            .getByRole("img", { name: "drone-survey.png" })
            .waitFor();
          await settled(page);
          await page.screenshot({
            path: `${shots}/large-picture-opened-${theme}-${shape}.png`,
          });
        } finally {
          await page.close();
        }
      }
    }
  },
  120_000,
);
