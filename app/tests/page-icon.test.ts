import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { Window } from "happy-dom";
import { oklchToHex } from "../../tokens/src/color";
import { scheme } from "../../tokens/src/scheme";

/*
 * OpenBot's own icon, wherever a browser or a phone looks for one: the tab, a phone's home screen,
 * and an installed app.
 *
 * Found on OpenBot Cloud (1.2.0): added to an iPhone's home screen, the app showed a grey square
 * with a white "O" in it. The page named an empty icon and no other, so the browser showed none in
 * its tab and the phone made up a letter. Before that (1.2.0-rc.5) it named none at all, and every
 * page load asked for /favicon.ico and got a 404. So every icon the page names, and every icon its
 * manifest names, is a file the built app ships and is served with its type and its size.
 *
 * The app is built here as a release builds it, and its files are answered as `app/serve.ts` and
 * the server answer a built file: the file, with the type its extension names.
 */

const APP = join(import.meta.dir, "..");
const BACKGROUND = oklchToHex(scheme.light.background);

let out = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let head: { rel: string; href: string; sizes: string | null }[] = [];

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "openbot-page-icon-"));
  const build = Bun.spawn({
    cmd: [
      process.execPath,
      "--bun",
      "node_modules/vite/bin/vite.js",
      "build",
      "--outDir",
      out,
      "--emptyOutDir",
      "--logLevel",
      "error",
    ],
    cwd: APP,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`the app did not build:\n${stderr}`);

  const html = await readFile(join(out, "index.html"), "utf8");
  const window = new Window();
  const document = new window.DOMParser().parseFromString(html, "text/html");
  head = [...document.querySelectorAll("head link[rel]")].map((link) => ({
    rel: link.getAttribute("rel") ?? "",
    href: link.getAttribute("href") ?? "",
    sizes: link.getAttribute("sizes"),
  }));
  await window.happyDOM.close();

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const wanted = normalize(join(out, new URL(request.url).pathname));
      if (!wanted.startsWith(`${out}${sep}`))
        return new Response("not found", { status: 404 });
      const found = Bun.file(wanted);
      if (await found.exists()) return new Response(found);
      return new Response("not found", { status: 404 });
    },
  });
}, 300_000);

afterAll(async () => {
  await server?.stop(true);
  if (out) await rm(out, { recursive: true, force: true });
});

async function served(path: string) {
  const response = await fetch(new URL(path, server?.url));
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/** The one link with this `rel`, read off the built page's head. */
function link(rel: string) {
  const found = head.filter((entry) => entry.rel.split(/\s+/).includes(rel));
  expect(found.map((entry) => entry.rel)).toEqual([rel]);
  return found[0] as (typeof head)[number];
}

/** A PNG's pixels, as RGBA, from the file's own bytes. */
function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png.readUInt8(24);
  const colorType = png.readUInt8(25);
  expect(depth).toBe(8);
  const channels = { 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`a PNG of color type ${colorType}`);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] as number;
      const left =
        x >= channels ? (rows[y * stride + x - channels] as number) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + x] as number) : 0;
      const corner =
        x >= channels && y > 0
          ? (rows[(y - 1) * stride + x - channels] as number)
          : 0;
      const guess = left + up - corner;
      const paeth =
        Math.abs(guess - left) <= Math.abs(guess - up) &&
        Math.abs(guess - left) <= Math.abs(guess - corner)
          ? left
          : Math.abs(guess - up) <= Math.abs(guess - corner)
            ? up
            : corner;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      if (predicted === undefined) throw new Error(`PNG filter ${filter}`);
      rows[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const pixel = (x: number, y: number) => {
    const at = (y * width + x) * channels;
    const [r, g, b] = [rows[at], rows[at + 1], rows[at + 2]] as number[];
    const alpha = channels === 4 ? (rows[at + 3] as number) : 255;
    return { r, g, b, alpha };
  };
  return { width, height, pixel };
}

function hex({ r, g, b }: { r: number; g: number; b: number }) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Every pixel solid, and the corners the background: no pixel a phone could fill with black. */
function expectSolidOnBackground(png: ReturnType<typeof decodePng>) {
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++)
      if (png.pixel(x, y).alpha !== 255)
        throw new Error(`a clear pixel at ${x},${y}`);
  for (const [x, y] of [
    [0, 0],
    [png.width - 1, 0],
    [0, png.height - 1],
    [png.width - 1, png.height - 1],
  ] as const)
    expect(hex(png.pixel(x, y))).toBe(BACKGROUND);
}

/**
 * OpenBot's orb in the middle: drawn, not the background. The desktop's orb is glass, a little
 * see-through even at its middle, so on a clear ground it is nearly solid rather than solid.
 */
function expectOrbInTheMiddle(png: ReturnType<typeof decodePng>) {
  const middle = png.pixel(png.width >> 1, png.height >> 1);
  expect(middle.alpha).toBeGreaterThan(200);
  expect(hex(middle)).not.toBe(BACKGROUND);
}

describe("the built page's icons", () => {
  test("the page names no empty icon", () => {
    for (const entry of head) expect(entry.href).not.toStartWith("data:");
  });

  test("a tab's icon: favicon.ico, 16, 32 and 48 pixels, OpenBot's orb", async () => {
    const icon = link("icon");
    const file = await served(icon.href);
    expect(file.status).toBe(200);
    expect(file.type).toBe("image/x-icon");
    const ico = file.body;
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let entry = 0; entry < count; entry++) {
      const at = 6 + entry * 16;
      const size = ico.readUInt8(at) || 256;
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      const png = decodePng(ico.subarray(offset, offset + length));
      expect([png.width, png.height]).toEqual([size, size]);
      expectOrbInTheMiddle(png);
      // Clear around the orb, so the tab's own color shows there.
      expect(png.pixel(0, 0).alpha).toBe(0);
      sizes.push(size);
    }
    expect(sizes).toEqual([16, 32, 48]);
    expect(icon.sizes).toBe("16x16 32x32 48x48");
  });

  test("a phone's home screen: apple-touch-icon.png, 180 pixels and solid", async () => {
    const file = await served(link("apple-touch-icon").href);
    expect(file.status).toBe(200);
    expect(file.type).toBe("image/png");
    const png = decodePng(file.body);
    expect([png.width, png.height]).toEqual([180, 180]);
    expectSolidOnBackground(png);
    expectOrbInTheMiddle(png);
  });

  test("an installed app: the manifest names OpenBot, the scheme's colors and its icons", async () => {
    const file = await served(link("manifest").href);
    expect(file.status).toBe(200);
    expect(file.type).toBe("application/manifest+json");
    const manifest = JSON.parse(file.body.toString("utf8"));
    expect(manifest).toMatchObject({
      name: "OpenBot",
      short_name: "OpenBot",
      start_url: "/",
      background_color: BACKGROUND,
      theme_color: BACKGROUND,
    });

    const icons: {
      src: string;
      sizes: string;
      type: string;
      purpose?: string;
    }[] = manifest.icons;
    expect(
      icons.map((icon) => `${icon.sizes} ${icon.purpose ?? "any"}`).sort(),
    ).toEqual([
      "192x192 any",
      "192x192 maskable",
      "512x512 any",
      "512x512 maskable",
    ]);
    for (const icon of icons) {
      const image = await served(icon.src);
      expect(`${icon.src} ${image.status} ${image.type}`).toBe(
        `${icon.src} 200 image/png`,
      );
      expect(icon.type).toBe("image/png");
      const png = decodePng(image.body);
      expect(`${png.width}x${png.height}`).toBe(icon.sizes);
      expectOrbInTheMiddle(png);
      if (icon.purpose === "maskable") expectSolidOnBackground(png);
      else expect(png.pixel(0, 0).alpha).toBe(0);
    }
  });

  test("the build ships every icon at the page's own root, so none is a 404", () => {
    for (const name of [
      "favicon.ico",
      "apple-touch-icon.png",
      "manifest.webmanifest",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-192.png",
      "icon-maskable-512.png",
    ])
      expect(`${name} ${existsSync(join(out, name))}`).toBe(`${name} true`);
  });
});
