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
 * The clips were cut out of a light background, and the cutout took the character's own whites with
 * it: on a dark page its eyes showed black. So where ffmpeg can re-encode VP9, each clip is mended
 * first (buddy-matte.ts), and its HEVC copy is written from the mended clip.
 *
 *   bun scripts/fetch-stock-buddies.ts
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  STOCK_BUDDIES,
  STOCK_BUDDY_SOURCE,
} from "../app/src/lib/buddies/stock";
import { mendHoles, type Size, stillFit, stillMask } from "./buddy-matte";

const root = join(import.meta.dir, "..", "app", "public", "buddies");

const encoders = (() => {
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
  });
  return probe.status === 0 ? probe.stdout : "";
})();

/** Whether this machine can write transparent HEVC: ffmpeg with VideoToolbox's encoder. */
const canWriteHevc = encoders.includes("hevc_videotoolbox");

/** Whether this machine can mend the clips: ffmpeg with libvpx's VP9 encoder. */
const canMend = encoders.includes("libvpx-vp9");

/** How the clips are mended. A buddy mended another way, or not at all, is unpacked again. */
const MENDED = "2";

/** What a buddy's .source says once it is unpacked, and mended where this machine can. */
const SOURCE_STAMP = canMend
  ? `${STOCK_BUDDY_SOURCE.commit} mended ${MENDED}`
  : STOCK_BUDDY_SOURCE.commit;

function sizeOf(file: string): Size {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    { encoding: "utf8" },
  );
  const [width, height] = probe.stdout.trim().split(",").map(Number);
  if (!width || !height) throw new Error(`Couldn't read the size of ${file}`);
  return { width, height };
}

/** Fills the holes in each clip's cutout, in place. A clip that can't be mended is left as it was. */
function mendClips(dir: string): void {
  const avatar = join(dir, "avatar.png");
  if (!existsSync(avatar)) return;
  const stillSize = sizeOf(avatar);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".webm")) continue;
    const file = join(dir, name);
    try {
      const clip = sizeOf(file);
      const fit = stillFit(stillSize, clip);
      const still = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          avatar,
          "-vf",
          `scale=${fit.width}:${fit.height}`,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-",
        ],
        { maxBuffer: 1 << 28 },
      ).stdout;
      const decoded = spawnSync(
        "ffmpeg",
        // libvpx's decoder, which keeps the clip's alpha.
        [
          "-v",
          "error",
          "-c:v",
          "libvpx-vp9",
          "-i",
          file,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-",
        ],
        { maxBuffer: 1 << 30 },
      );
      if (decoded.status !== 0) throw new Error(String(decoded.stderr));
      const frames = new Uint8Array(decoded.stdout);
      mendHoles(frames, clip, stillMask(new Uint8Array(still), fit, clip));
      const rate = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=r_frame_rate",
          "-of",
          "csv=p=0",
          file,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      const mended = join(dir, `${name}.mended.webm`);
      const run = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-s",
          `${clip.width}x${clip.height}`,
          "-r",
          rate || "24",
          "-i",
          "-",
          "-i",
          file,
          "-map",
          "0:v",
          "-map",
          "1:a?",
          "-c:v",
          "libvpx-vp9",
          "-pix_fmt",
          "yuva420p",
          "-crf",
          "28",
          "-b:v",
          "0",
          "-row-mt",
          "1",
          "-auto-alt-ref",
          "0",
          "-c:a",
          "copy",
          mended,
        ],
        { input: frames, maxBuffer: 1 << 26 },
      );
      if (run.status !== 0) throw new Error(String(run.stderr));
      renameSync(mended, file);
    } catch (error) {
      console.warn(`buddies: couldn't mend ${file}: ${error}`);
    }
  }
}

/**
 * How the HEVC copies are written. A folder whose copies were written another way has them written
 * again. 2: premultiplied. WebKit reads an HEVC clip's colour as premultiplied by its alpha, so a
 * straight copy drew a light grey fringe around the character on a dark page.
 */
const HEVC_COPIES = "2";

/** Each clip's transparent HEVC copy, for WebKit. A copy already written this way is kept. */
function writeHevcCopies(dir: string): void {
  const stamp = join(dir, ".hevc");
  const current =
    existsSync(stamp) && readFileSync(stamp, "utf8").trim() === HEVC_COPIES;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".webm")) continue;
    const copy = join(dir, name.replace(/\.webm$/, ".hevc.mp4"));
    if (current && existsSync(copy)) continue;
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
      // Premultiplied, as WebKit composites it.
      "format=rgba,premultiply=inplace=1,format=bgra",
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
  writeFileSync(stamp, `${HEVC_COPIES}\n`);
}

async function fetchOne(id: string, file: string): Promise<void> {
  const dir = join(root, id);
  const stamp = join(dir, ".source");
  if (
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === SOURCE_STAMP
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
  if (canMend) mendClips(dir);
  // The clips are new, so their HEVC copies are written again.
  rmSync(join(dir, ".hevc"), { force: true });
  if (canWriteHevc) writeHevcCopies(dir);
  writeFileSync(stamp, `${SOURCE_STAMP}\n`);
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
