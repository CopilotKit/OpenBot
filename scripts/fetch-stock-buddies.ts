/**
 * Downloads the stock buddies into app/public/buddies/<id>/, unpacked: metadata.json, the still
 * avatar and one clip per pose. Unpacked so a small avatar loads only its picture, and a clip loads
 * only when its pose plays. The folder is gitignored: the eleven files are 79 MB.
 *
 * They come from labs-buddy at a pinned commit, which is public, so no sign-in is needed. A buddy
 * already unpacked from that commit is skipped, so a second run does nothing.
 *
 * Safari, and the WebKit window OpenBot Desktop draws on a Mac, don't draw a WebM clip's transparency:
 * a stock buddy's clips play there on black. So on a Mac whose ffmpeg has VideoToolbox's HEVC encoder,
 * each clip also gets a transparent HEVC copy beside it (<pose>.hevc.mp4), which WebKit plays. Without one,
 * WebKit shows the buddy's still picture (bot-buddy.tsx).
 *
 *   bun scripts/fetch-stock-buddies.ts
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  STOCK_BUDDIES,
  STOCK_BUDDY_SOURCE,
} from "../app/src/lib/buddies/stock";

const root = join(import.meta.dir, "..", "app", "public", "buddies");

/** Whether this machine can write transparent HEVC: ffmpeg with VideoToolbox's encoder. */
const canWriteHevc = (() => {
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.includes("hevc_videotoolbox");
})();

/** Each clip's transparent HEVC copy, for WebKit. A copy already written is kept. */
function writeHevcCopies(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".webm")) continue;
    const copy = join(dir, name.replace(/\.webm$/, ".hevc.mp4"));
    if (existsSync(copy)) continue;
    const run = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      // libvpx's decoder, which keeps the clip's alpha; ffmpeg's own VP9 decoder drops it.
      "-c:v",
      "libvpx-vp9",
      "-i",
      join(dir, name),
      "-vf",
      "format=bgra",
      "-c:v",
      "hevc_videotoolbox",
      "-alpha_quality",
      "0.75",
      "-b:v",
      "700k",
      "-tag:v",
      "hvc1",
      "-an",
      // The index first, so a clip starts playing before it has all arrived.
      "-movflags",
      "+faststart",
      copy,
    ]);
    if (run.status !== 0)
      console.warn(`buddies: couldn't write ${copy}: ${run.stderr}`);
  }
}

async function fetchOne(id: string, file: string): Promise<void> {
  const dir = join(root, id);
  const stamp = join(dir, ".source");
  if (
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === STOCK_BUDDY_SOURCE.commit
  ) {
    if (canWriteHevc) writeHevcCopies(dir);
    return;
  }
  const url = `${STOCK_BUDDY_SOURCE.base}/${STOCK_BUDDY_SOURCE.commit}/${STOCK_BUDDY_SOURCE.path}/${file}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Couldn't download ${file}: HTTP ${response.status}`);
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) {
    // Only flat file names: a zip entry is never let out of its folder.
    if (
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name.startsWith(".")
    )
      continue;
    writeFileSync(join(dir, name), bytes);
  }
  if (canWriteHevc) writeHevcCopies(dir);
  writeFileSync(stamp, `${STOCK_BUDDY_SOURCE.commit}\n`);
  console.info(`buddies: ${id}`);
}

if (process.env.OPENBOT_SKIP_STOCK_BUDDIES) {
  console.info("buddies: skipped (OPENBOT_SKIP_STOCK_BUDDIES)");
} else {
  mkdirSync(root, { recursive: true });
  const results = await Promise.allSettled(
    STOCK_BUDDIES.map((buddy) => fetchOne(buddy.id, buddy.file)),
  );
  const failed = results.filter((result) => result.status === "rejected");
  for (const failure of failed)
    console.warn(`buddies: ${(failure as PromiseRejectedResult).reason}`);
  // A missing buddy draws as its Bot's orb, so a failed download never stops a build.
  if (failed.length > 0)
    console.warn(
      `buddies: ${failed.length} of ${STOCK_BUDDIES.length} stock buddies are missing.`,
    );
}
