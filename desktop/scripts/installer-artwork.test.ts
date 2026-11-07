/**
 * The Windows installer shows OpenBot's own artwork, not NSIS's stock blue.
 *
 * v0.3.2's installer had NSIS's navy Welcome and Finish sidebar and its disk icon in the title bar,
 * because tauri.conf.json named no images. These hold the config the desktop CI build and the
 * Windows signing build both use to the files, and the files to the sizes Tauri and Modern UI
 * document: a 164x314 sidebar and a 150x57 header, as 24-bit BMPs.
 * src-tauri/windows/installer-artwork.ts draws them.
 *
 * Plain file reads only, so it runs on any runner.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tauri = join(import.meta.dir, "..", "src-tauri");
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(tauri, file), "utf8"));

type Json = Record<string, unknown>;

/** RFC 7396 merge, as `tauri build --config` lays an overlay on tauri.conf.json. */
function merge(base: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return patch;
  const out: Json =
    typeof base === "object" && base !== null && !Array.isArray(base)
      ? { ...(base as Json) }
      : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

const nsisOf = (config: unknown) =>
  ((config as { bundle?: { windows?: { nsis?: Json } } }).bundle?.windows
    ?.nsis ?? {}) as Record<string, string | undefined>;

function bmp(path: string) {
  const file = readFileSync(path);
  const width = file.readInt32LE(18);
  const height = file.readInt32LE(22);
  const stride = Math.ceil((width * 3) / 4) * 4;
  // The top-left pixel: rows are stored bottom-up, BGR.
  const topLeft = 54 + (height - 1) * stride;
  return {
    magic: file.toString("ascii", 0, 2),
    size: file.readUInt32LE(2),
    length: file.length,
    pixels: file.readUInt32LE(10),
    header: file.readUInt32LE(14),
    width,
    height,
    planes: file.readUInt16LE(26),
    bits: file.readUInt16LE(28),
    compression: file.readUInt32LE(30),
    topLeft: [file[topLeft + 2], file[topLeft + 1], file[topLeft]],
  };
}

const builds = {
  "desktop CI": readJson("tauri.conf.json"),
  "Windows signing": merge(
    readJson("tauri.conf.json"),
    readJson("tauri.windows-signing.conf.json"),
  ),
};

for (const [build, config] of Object.entries(builds)) {
  test(`the ${build} build names OpenBot's installer artwork`, () => {
    expect(nsisOf(config)).toMatchObject({
      installerIcon: "./icons/icon.ico",
      uninstallerIcon: "./icons/icon.ico",
      headerImage: "./windows/installer-header.bmp",
      sidebarImage: "./windows/installer-sidebar.bmp",
    });
  });
}

for (const [key, width, height] of [
  ["sidebarImage", 164, 314],
  ["headerImage", 150, 57],
] as const) {
  test(`${key} is a ${width}x${height} 24-bit BMP on a light ground`, () => {
    const path = join(tauri, nsisOf(builds["desktop CI"])[key] ?? "");
    expect(existsSync(path)).toBe(true);
    const image = bmp(path);
    expect(image).toMatchObject({
      magic: "BM",
      pixels: 54,
      header: 40,
      width,
      height,
      planes: 1,
      bits: 24,
      compression: 0,
    });
    expect(image.size).toBe(image.length);
    expect(image.length).toBe(54 + Math.ceil((width * 3) / 4) * 4 * height);
    // NSIS's stock sidebar is navy. OpenBot's grounds are its light frame and its white header.
    for (const channel of image.topLeft) expect(channel).toBeGreaterThan(200);
  });
}

test("the installer and uninstaller icon is the app's icon, with small and large frames", () => {
  const file = readFileSync(join(tauri, "icons", "icon.ico"));
  expect(file.readUInt16LE(0)).toBe(0);
  expect(file.readUInt16LE(2)).toBe(1);
  const sizes = Array.from(
    { length: file.readUInt16LE(4) },
    (_, i) => file[6 + i * 16] || 256,
  );
  expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
});

test("the header image sits on the right, where NSIS's icon was", () => {
  const hooks = readFileSync(join(tauri, "windows", "hooks.nsh"), "utf8");
  expect(hooks).toMatch(/^!define MUI_HEADERIMAGE_RIGHT$/m);
});
