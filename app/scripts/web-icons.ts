/**
 * Writes the web app's icons into `app/public`, from OpenBot Desktop's own icon.
 *
 * The source is `desktop/src-tauri/icons/icon.png`, the orb's 1024px master that the desktop app,
 * its tray and the web app's own logo are drawn from (desktop/src-tauri/icons/README.md). Nothing
 * here draws the mark again: each file is the master scaled down, alone on a clear ground, or on
 * the scheme's light `background` where a platform wants a square with no clear pixels in it:
 *
 * - `favicon.ico`: 16, 32 and 48 pixels, clear around the orb. A browser's tab.
 * - `icon-192.png`, `icon-512.png`: clear around the orb. An installed app's icon and splash.
 * - `icon-maskable-192.png`, `icon-maskable-512.png`: the orb inside the safe zone a phone crops a
 *   maskable icon to (a circle 80% across), on the background, so no shape a launcher cuts reaches
 *   the orb.
 * - `apple-touch-icon.png`: 180 pixels, as the maskable ones. iOS fills a clear pixel with black, so
 *   an icon added to the home screen is square and solid.
 *
 * `manifest.webmanifest` beside them names them; `bun run tokens:generate` writes it, since it
 * carries the scheme's colors. Run this again when the desktop's icon or the light background
 * changes:
 *
 *   bun app/scripts/web-icons.ts
 *
 * It scales in Chromium, through playwright-core (the root package's own dependency), so the steps
 * are a browser's resampling and nothing more: halved one step at a time, each step averaging the
 * pixels under it, and the last step to the size asked for.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { oklchToHex } from "../../tokens/src/color";
import { scheme } from "../../tokens/src/scheme";

const ROOT = join(import.meta.dir, "../..");
const MASTER = join(ROOT, "desktop/src-tauri/icons/icon.png");
const PUBLIC = join(import.meta.dir, "../public");

/** The light page's ground, as a phone's square icon is filled with. */
const ICON_BACKGROUND = oklchToHex(scheme.light.background);
/** How much of a square icon the master takes: the maskable safe zone, a circle 80% across. */
const SAFE_ZONE = 0.8;

type Icon = {
  size: number;
  /** A solid square on the background, or the orb on a clear ground. */
  solid: boolean;
};

const PNGS: Record<string, Icon> = {
  "icon-192.png": { size: 192, solid: false },
  "icon-512.png": { size: 512, solid: false },
  "icon-maskable-192.png": { size: 192, solid: true },
  "icon-maskable-512.png": { size: 512, solid: true },
  "apple-touch-icon.png": { size: 180, solid: true },
};
const FAVICON_SIZES = [16, 32, 48];

/**
 * An ICO file holding each PNG as it is, which every browser reads: a 6-byte header, a 16-byte
 * entry per image, then the images.
 */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

if (import.meta.main) {
  const master = `data:image/png;base64,${readFileSync(MASTER).toString("base64")}`;
  const browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent("<!doctype html><title>icons</title>");
    const render = async ({ size, solid }: Icon): Promise<Buffer> => {
      const url = await page.evaluate(
        async ({ master, size, solid, background, safeZone }) => {
          const image = new Image();
          image.src = master;
          await image.decode();
          const drawn = Math.round(solid ? size * safeZone : size);
          // Halve while the next half is still at least the size drawn, so no step skips pixels.
          let source: CanvasImageSource = image;
          let width = image.naturalWidth;
          while (width / 2 >= drawn) {
            width = Math.round(width / 2);
            const step = document.createElement("canvas");
            step.width = width;
            step.height = width;
            const context = step.getContext("2d");
            if (!context) throw new Error("no 2d context");
            context.imageSmoothingQuality = "high";
            context.drawImage(source, 0, 0, width, width);
            source = step;
          }
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext("2d", { alpha: !solid });
          if (!context) throw new Error("no 2d context");
          if (solid) {
            context.fillStyle = background;
            context.fillRect(0, 0, size, size);
          }
          context.imageSmoothingQuality = "high";
          const inset = (size - drawn) / 2;
          context.drawImage(source, inset, inset, drawn, drawn);
          return canvas.toDataURL("image/png");
        },
        {
          master,
          size,
          solid,
          background: ICON_BACKGROUND,
          safeZone: SAFE_ZONE,
        },
      );
      return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    };

    for (const [name, icon] of Object.entries(PNGS)) {
      writeFileSync(join(PUBLIC, name), await render(icon));
      console.log(`wrote app/public/${name}`);
    }
    const frames = [];
    for (const size of FAVICON_SIZES)
      frames.push({ size, png: await render({ size, solid: false }) });
    writeFileSync(join(PUBLIC, "favicon.ico"), ico(frames));
    console.log("wrote app/public/favicon.ico");
  } finally {
    await browser.close();
  }
}
