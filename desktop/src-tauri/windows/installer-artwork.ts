/**
 * Draws the Windows installer's two bitmaps from the setup window's own artwork.
 *
 *   bun desktop/src-tauri/windows/installer-artwork.ts
 *
 * from the repository root, after `bun install` there: it uses the root's playwright-core and that
 * version's Chromium (`bunx playwright-core install chromium`).
 *
 * NSIS shows `installer-sidebar.bmp` down the left of the Welcome and Finish pages and
 * `installer-header.bmp` at the right of every other page's header, in place of its stock blue
 * artwork. Both are set in tauri.conf.json (`bundle.windows.nsis`), which the desktop CI build
 * and the Windows signing build share.
 *
 * Nothing is redrawn: the orb is the `.orb` rules from desktop/src/styles.css, rendered by Chromium,
 * and the sidebar's ground is the window's own frame, `--sidebar`. The installer has no dark mode,
 * so these are the light values. There is no text in either image: NSIS scales a bitmap with nearest
 * neighbour when Windows runs above 100%, which a soft orb survives and lettering does not.
 *
 * The sizes are the ones Tauri and NSIS's Modern UI document, 164x314 and 150x57, as 24-bit BMPs.
 * desktop/scripts/installer-artwork.test.ts holds the files to them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const out = import.meta.dir;
const desktop = join(out, "..", "..");

const SIDEBAR = { file: "installer-sidebar.bmp", width: 164, height: 314 };
const HEADER = { file: "installer-header.bmp", width: 150, height: 57 };

/** The `.orb` rules, exactly as the setup window has them. */
function orbRules(css: string): string {
  return [".orb", ".orb::before", ".orb::after"]
    .map((selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = [
        ...css.matchAll(new RegExp(`^${escaped} \\{[^}]*\\}`, "gm")),
      ];
      if (matches.length !== 1)
        throw new Error(`Expected exactly one ${selector} rule`);
      return matches[0][0];
    })
    .join("\n");
}

/** A token's light value, from the stylesheet's first `:root`. */
function token(css: string, name: string): string {
  const root = css.match(/^:root \{[^}]*\}/m)?.[0] ?? "";
  const value = root.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`No ${name} in :root`);
  return value.trim();
}

/** A 24-bit, bottom-up, uncompressed BMP: the form NSIS loads. */
function encodeBmp(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + stride * height;
  const bmp = Buffer.alloc(size);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(size, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(0, 30);
  bmp.writeUInt32LE(stride * height, 34);
  bmp.writeInt32LE(2835, 38);
  bmp.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      bmp[row + x * 3] = rgba[p + 2];
      bmp[row + x * 3 + 1] = rgba[p + 1];
      bmp[row + x * 3 + 2] = rgba[p];
    }
  }
  return bmp;
}

async function main() {
  const css = readFileSync(join(desktop, "src", "styles.css"), "utf8");
  const orb = orbRules(css);
  const frame = token(css, "--sidebar");
  const card = token(css, "--card");

  const browser = await chromium.launch({
    args: ["--force-color-profile=srgb"],
  });
  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    await page.route("**/*", (route) => route.abort());

    const draw = async (
      { file, width, height }: { file: string; width: number; height: number },
      body: string,
      style: string,
    ) => {
      await page.setViewportSize({ width, height });
      await page.setContent(
        `<style>${orb}\nhtml, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }\n${style}</style>${body}`,
      );
      const png = await page.screenshot({
        animations: "disabled",
        scale: "device",
      });
      // Decode in the page: Chromium already reads PNG, so the script needs no image library.
      const rgba = await page.evaluate(
        async ({ src, width, height }) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
          if (!ctx) throw new Error("No 2D context");
          ctx.drawImage(img, 0, 0);
          return Array.from(ctx.getImageData(0, 0, width, height).data);
        },
        {
          src: `data:image/png;base64,${png.toString("base64")}`,
          width,
          height,
        },
      );
      writeFileSync(
        join(out, file),
        encodeBmp(width, height, Uint8ClampedArray.from(rgba)),
      );
      console.log(`Wrote ${file} (${width}x${height})`);
    };

    // The sidebar: the window's lavender frame, with the orb at twice its 32px size, centred across
    // and set in the upper third, level with the page's heading block.
    await draw(
      SIDEBAR,
      `<div class="place"><div class="orb"></div></div>`,
      `body { background: ${frame}; position: relative; }
       .place { position: absolute; left: 50px; top: 74px; width: 64px; height: 64px; }
       .orb { zoom: 2; }`,
    );

    // The header: the page header's white, with the orb at its own 32px, right-aligned where NSIS
    // put its icon.
    await draw(
      HEADER,
      `<div class="place"><div class="orb"></div></div>`,
      `body { background: ${card}; position: relative; }
       .place { position: absolute; right: 14px; top: 12px; width: 32px; height: 32px; }`,
    );
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
