import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";

// ---- Format version --------------------------------------------------------
// The .buddy format version this library reads and writes. Bumped only for a
// breaking change; additive, optional fields never bump it (see the format
// reference). Missing version in a file is treated as 1; a newer version than
// this reader understands throws BuddyVersionError.
export const BUDDY_FORMAT_VERSION = 1;

/** Thrown when a .buddy declares a format version newer than this reader. */
export class BuddyVersionError extends Error {
  readonly fileVersion: number;
  readonly readerVersion: number;
  constructor(fileVersion: number) {
    super(
      `This .buddy file is format version ${fileVersion}, but this reader only understands up to version ${BUDDY_FORMAT_VERSION}. Upgrade @tanstack/buddy-file to open it.`,
    );
    this.name = "BuddyVersionError";
    this.fileVersion = fileVersion;
    this.readerVersion = BUDDY_FORMAT_VERSION;
  }
}

/** Thrown when a .buddy's metadata.json is missing, unparseable, or malformed. */
export class BuddyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuddyFormatError";
  }
}

// ---- Poses -----------------------------------------------------------------
// The agent-lifecycle poses, in rough order:
// greet → wait → listen → reason → search/read/work → write/talk → ask/done/error.
export const POSE_IDS = [
  "greeting",
  "idle",
  "listening",
  "thinking",
  "thinkingHard",
  "searching",
  "reading",
  "working",
  "writing",
  "typing",
  "talking",
  "speaking",
  "asking",
  "done",
  "error",
  "sleeping",
  "goodbye",
] as const;

export type PoseId = (typeof POSE_IDS)[number];

export type PoseDef = { id: PoseId; label: string; prompt: string };

// Motion-only prompts — appearance comes from the start-frame avatar, so the
// character stays consistent. LOOP_SUFFIX pins the white background, keeps the
// whole body centered, and asks for a static-camera, loopable animation.
export const LOOP_SUFFIX =
  " Plain solid white background. Keep the character small, centered, and fully in frame from head to toe with generous white margins on every side. Static camera, wide shot. Seamless loop.";

export const POSES: Array<PoseDef> = [
  {
    id: "greeting",
    label: "Greeting",
    prompt:
      "The full-body character waves hello with one raised hand and smiles warmly, a friendly welcoming greeting.",
  },
  {
    id: "idle",
    label: "Idle",
    prompt:
      "The full-body character stands in place, breathing gently, blinking, with a subtle friendly sway and the occasional small weight shift.",
  },
  {
    id: "listening",
    label: "Listening",
    prompt:
      "The full-body character cups one hand to its ear and leans in attentively, nodding slightly as if listening carefully.",
  },
  {
    id: "thinking",
    label: "Thinking",
    prompt:
      "The full-body character looks up and to the side, tilts its head and taps a finger to its chin while pondering, one hand resting near its hip. Gentle and cute.",
  },
  {
    id: "thinkingHard",
    label: "Thinking hard",
    prompt:
      "The full-body character furrows its brow in deep concentration, scratches its head and shifts its weight, intensely pondering. Cute and expressive.",
  },
  {
    id: "searching",
    label: "Searching",
    prompt:
      "The full-body character holds up a magnifying glass and leans forward, peering through it and scanning left and right as if searching for something.",
  },
  {
    id: "reading",
    label: "Reading",
    prompt:
      "The full-body character holds an open book up in both hands and reads, eyes scanning left to right, occasionally turning a page.",
  },
  {
    id: "working",
    label: "Working",
    prompt:
      "The full-body character rolls up its sleeves and taps busily on a small handheld gadget, focused and industrious.",
  },
  {
    id: "writing",
    label: "Writing",
    prompt:
      "The full-body character holds a pencil and a small notepad, looking down and writing busily, glancing up now and then.",
  },
  {
    id: "typing",
    label: "Typing",
    prompt:
      "The full-body character mimes typing eagerly on an invisible keyboard with both hands held in front of it, looking down with focus, fingers tapping quickly.",
  },
  {
    id: "talking",
    label: "Talking",
    prompt:
      "The full-body character gestures with both hands while cheerfully talking and explaining something, lively and friendly.",
  },
  {
    id: "speaking",
    label: "Speaking",
    prompt:
      "The full-body character stands relaxed facing forward and speaks warmly in a calm conversational rhythm, mouth moving naturally with a friendly expression and subtle head nods, arms resting calmly at its sides without hand gestures.",
  },
  {
    id: "asking",
    label: "Asking",
    prompt:
      "The full-body character raises one hand with a finger pointed up and tilts its head curiously, as if politely asking a question.",
  },
  {
    id: "done",
    label: "Done",
    prompt:
      "The full-body character gives an enthusiastic two-thumbs-up and a happy little hop, celebrating a job well done.",
  },
  {
    id: "error",
    label: "Confused",
    prompt:
      "The full-body character scratches its head and shrugs with both palms up, looking puzzled and unsure.",
  },
  {
    id: "sleeping",
    label: "Sleeping",
    prompt:
      'The full-body character is curled up asleep, eyes closed, breathing slowly and peacefully, with a tiny "Z" or two drifting upward. Calm and cozy.',
  },
  {
    id: "goodbye",
    label: "Goodbye",
    prompt:
      "The full-body character waves goodbye with one hand held high and a warm, slightly wistful smile, as if seeing you off.",
  },
];

// Generated up front on "Generate Buddy"; the rest render lazily on first tap.
export const EAGER_POSE_IDS: Array<PoseId> = ["idle", "thinking", "typing"];

export function poseLabel(id: PoseId): string {
  return POSES.find((p) => p.id === id)?.label ?? id;
}

// ---- .buddy file format ----------------------------------------------------
// A .buddy is a zip: metadata.json + avatar.<ext> + [inspiration.<ext>] +
// <pose>.mp4 (one per pose present, standard or custom). metadata.json is the
// sole manifest; every other entry is payload referenced from it.
//
// The Zod schemas below are the single source of truth for the format — the
// BuddyMeta / CustomPoseDef types are derived from them (z.infer), and every
// read path validates through them (see parseBuddyMeta). Schemas are strict on
// structure and identity (format tag, required string fields, well-formed pose
// map and custom defs) but tolerant on completeness: a missing optional file or
// a pose with no clip degrades through the loaders, it does not fail the parse.

/** An app-specific pose carried in a buddy's metadata (beyond the standard
 * POSE_IDS). `prompt` documents what it depicts so it can be re-rolled;
 * `fallback` names the standard pose it was designed against (used by
 * resolvePose when the custom clip is absent). */
export const CustomPoseDefSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  prompt: z.string().optional(),
  fallback: z.string().optional(),
});
export type CustomPoseDef = z.infer<typeof CustomPoseDefSchema>;

export const BuddyMetaSchema = z.object({
  format: z.literal("buddy"),
  // Optional on read (missing ⇒ 1, normalized by parseBuddyMeta); packBuddy
  // always stamps the current version on write.
  version: z.number().int().optional(),
  id: z.string(),
  name: z.string(),
  prompt: z.string().optional(),
  personality: z.string().optional(),
  avatar: z.string(),
  inspiration: z.string().optional(),
  /** Whether the buddy's avatar + pose clips carry a real alpha channel, so a
   * consuming app can put any background behind the character. Missing ⇒ opaque
   * (every existing file). Additive, no version bump. See isTransparentBuddy. */
  background: z.enum(["opaque", "transparent"]).optional(),
  /** The pose the runtime rests on. Should name a key of `poses`; a dangling
   * value is tolerated (the controller's fallback chain covers it). */
  homePose: z.string().optional(),
  // Keyed by PoseId for the standard poses, but arbitrary string keys are
  // allowed for app-specific custom poses (see `customPoses`).
  poses: z.record(z.string(), z.string()).default({}),
  /** Definitions for any non-standard poses present in `poses`. */
  customPoses: z.array(CustomPoseDefSchema).optional(),
});
export type BuddyMeta = z.infer<typeof BuddyMetaSchema>;

/** True when a buddy is marked for a transparent (alpha) background — its avatar
 * and pose clips carry a real alpha channel and composite over any host
 * background. Missing/`'opaque'` ⇒ false (every pre-transparency file). */
export function isTransparentBuddy(
  meta: Pick<BuddyMeta, "background">,
): boolean {
  return meta.background === "transparent";
}

// Alpha-capable file extensions a transparent buddy must use for each asset
// kind (the pack-time honesty check in packBuddy enforces this). Static images:
// PNG/WebP/GIF carry alpha; JPEG cannot. Clips: WebM (VP9+alpha) or MOV (HEVC
// alpha); MP4 does not carry a usable alpha channel here.
const ALPHA_IMAGE_EXTS = [".png", ".webp", ".gif"];
const ALPHA_VIDEO_EXTS = [".webm", ".mov"];

function hasExt(name: string, exts: Array<string>): boolean {
  const n = name.toLowerCase();
  return exts.some((e) => n.endsWith(e));
}

/** Future-version migrations land here. Currently the identity: the only shipped
 * version is 1, and older-but-known versions need no transform yet. */
function migrateBuddyMeta(meta: BuddyMeta): BuddyMeta {
  return meta;
}

// The known keys of each schema, derived from the schema shape so they can't
// drift from the definitions above. Anything in metadata.json outside these is
// an unknown field — carried verbatim, never typed (see carryUnknownFields).
const KNOWN_META_KEYS = new Set(Object.keys(BuddyMetaSchema.shape));
const KNOWN_CUSTOM_KEYS = new Set(Object.keys(CustomPoseDefSchema.shape));

/**
 * Additive-only policy: a newer minor writer may add optional fields this reader
 * doesn't know. Zod strips unknown keys on parse, which would silently eat those
 * fields on any parse → repack (addPoseToBuddy / augment-on-ingest). So merge the
 * raw object's unknown keys back over the validated result — top-level and on
 * each `customPoses` entry (matched by index) — so they survive repack. Known
 * fields keep their validated values (no duplication, no loosened strictness);
 * the typed BuddyMeta surface is unchanged — unknowns are carried, not typed.
 */
function carryUnknownFields(parsed: BuddyMeta, raw: unknown): BuddyMeta {
  if (!raw || typeof raw !== "object") return parsed;
  const rawObj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...parsed };
  for (const k of Object.keys(rawObj)) {
    if (!KNOWN_META_KEYS.has(k)) out[k] = rawObj[k];
  }
  if (Array.isArray(parsed.customPoses) && Array.isArray(rawObj.customPoses)) {
    const rawCustom = rawObj.customPoses as Array<unknown>;
    out.customPoses = parsed.customPoses.map((entry, i) => {
      const rawEntry = rawCustom[i];
      if (!rawEntry || typeof rawEntry !== "object") return entry;
      const re = rawEntry as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...entry };
      for (const k of Object.keys(re)) {
        if (!KNOWN_CUSTOM_KEYS.has(k)) merged[k] = re[k];
      }
      return merged;
    }) as BuddyMeta["customPoses"];
  }
  return out as BuddyMeta;
}

/**
 * The one read path for metadata. Validates structure/identity via the schema,
 * applies the version policy (missing ⇒ 1; newer than this reader ⇒
 * BuddyVersionError; older ⇒ migrate), carries any unknown fields through
 * (additive-only policy), and returns a normalized BuddyMeta.
 * Throws BuddyFormatError on malformed input with a readable message.
 */
export function parseBuddyMeta(raw: unknown): BuddyMeta {
  const result = BuddyMetaSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BuddyFormatError(`Invalid .buddy metadata — ${detail}`);
  }
  const meta = result.data;
  const version = meta.version ?? 1;
  if (version > BUDDY_FORMAT_VERSION) throw new BuddyVersionError(version);
  return migrateBuddyMeta(carryUnknownFields({ ...meta, version }, raw));
}

export type LoadedBuddy = {
  meta: BuddyMeta;
  avatarUrl: string | null;
  inspirationUrl: string | null;
  // Any pose present in the .buddy (standard POSE_IDS + custom ids).
  poseUrls: Record<string, string>;
  /** The file's resting pose, resolved against the clips actually present
   * (undefined when the file names none or names a dangling one — the
   * controller's own fallback chain then applies). */
  homePose?: string;
  /**
   * Ownership of this instance's object URLs:
   * - `owned`: minted by a one-off loader (loadBuddyFromFile / loadBuddyFromZip);
   *   the caller owns the URLs and revokeBuddy revokes them.
   * - `shared`: minted by getBuddy and held in the cache; the cache owns the
   *   URLs and revokeBuddy is a safe no-op.
   */
  kind: "owned" | "shared";
  /** object URLs to revoke when the buddy is no longer displayed */
  objectUrls: Array<string>;
};

export type BuddyHeader = {
  meta: BuddyMeta;
  avatarUrl: string | null;
  objectUrls: Array<string>;
};

// Seed values for "start with an existing buddy".
export type BuddySeed = {
  name: string;
  prompt?: string;
  personality?: string;
  avatarDataUri?: string;
};

export function mimeFor(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".webm")) return "video/webm";
  if (n.endsWith(".mov")) return "video/quicktime";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

// Universal base64 encode — Buffer on Node, chunked btoa in the browser.
export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as {
    Buffer?: { from(b: Uint8Array): { toString(enc: string): string } };
  };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---- isomorphic zip helpers (usable on the server) -------------------------

/** Parse + validate a metadata.json byte payload through the one read path. */
export function parseBuddyMetaBytes(bytes: Uint8Array): BuddyMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(bytes));
  } catch (e) {
    throw new BuddyFormatError(
      `metadata.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  return parseBuddyMeta(raw);
}

export function readMetadataFromZip(zip: Uint8Array): BuddyMeta {
  const metaOnly = unzipSync(zip, {
    filter: (f) => f.name === "metadata.json",
  });
  if (!metaOnly["metadata.json"])
    throw new BuddyFormatError("metadata.json missing from .buddy file");
  return parseBuddyMetaBytes(metaOnly["metadata.json"]);
}

/** metadata + avatar inlined as a data URI — for library/picker thumbnails. */
export function readAvatarDataUriFromZip(
  zip: Uint8Array,
  meta?: BuddyMeta,
): string | null {
  const m = meta ?? readMetadataFromZip(zip);
  if (!m.avatar) return null;
  const av = unzipSync(zip, { filter: (f) => f.name === m.avatar });
  if (!av[m.avatar]) return null;
  return `data:${mimeFor(m.avatar)};base64,${bytesToBase64(av[m.avatar])}`;
}

export function readBuddySeedFromZip(zip: Uint8Array): BuddySeed {
  const meta = readMetadataFromZip(zip);
  const avatarDataUri = readAvatarDataUriFromZip(zip, meta) ?? undefined;
  return {
    name: meta.name,
    prompt: meta.prompt,
    personality: meta.personality,
    avatarDataUri,
  };
}

/**
 * Build a .buddy zip from in-memory bytes (filename → bytes). Stamps the current
 * format version and verifies every file reference in `meta` (avatar,
 * inspiration, each pose) exists in `assets` before zipping — a dangling
 * reference throws, naming the offending file.
 */
export function packBuddy(
  meta: BuddyMeta,
  assets: Record<string, Uint8Array>,
): Uint8Array {
  const stamped: BuddyMeta = { ...meta, version: BUDDY_FORMAT_VERSION };

  const refs: Array<{ field: string; name: string }> = [];
  if (stamped.avatar) refs.push({ field: "avatar", name: stamped.avatar });
  if (stamped.inspiration)
    refs.push({ field: "inspiration", name: stamped.inspiration });
  for (const [id, name] of Object.entries(stamped.poses ?? {})) {
    refs.push({ field: `poses.${id}`, name });
  }
  for (const { field, name } of refs) {
    if (!(name in assets)) {
      throw new BuddyFormatError(
        `packBuddy: ${field} references "${name}" but no such file is present in assets`,
      );
    }
  }

  // Transparent-background honesty check: a buddy marked transparent must
  // reference alpha-capable assets, or the "transparent" marker would be a lie
  // (a consuming app would composite an opaque rectangle). Opaque buddies are
  // unchecked, exactly as before.
  if (isTransparentBuddy(stamped)) {
    const imageRefs: Array<{ field: string; name: string }> = [];
    if (stamped.avatar)
      imageRefs.push({ field: "avatar", name: stamped.avatar });
    if (stamped.inspiration)
      imageRefs.push({ field: "inspiration", name: stamped.inspiration });
    for (const { field, name } of imageRefs) {
      if (!hasExt(name, ALPHA_IMAGE_EXTS)) {
        throw new BuddyFormatError(
          `packBuddy: ${field} references "${name}" but the buddy is marked background: 'transparent'; a transparent avatar must be ${ALPHA_IMAGE_EXTS.join(", ")}`,
        );
      }
    }
    for (const [id, name] of Object.entries(stamped.poses ?? {})) {
      if (!hasExt(name, ALPHA_VIDEO_EXTS)) {
        throw new BuddyFormatError(
          `packBuddy: poses.${id} references "${name}" but the buddy is marked background: 'transparent'; pose clips must be ${ALPHA_VIDEO_EXTS.join(", ")}`,
        );
      }
    }
  }

  const entries: Record<string, Uint8Array> = {
    "metadata.json": strToU8(JSON.stringify(stamped, null, 2)),
    ...assets,
  };
  return zipSync(entries, { level: 6 });
}

// ---- Completeness ----------------------------------------------------------
// Completeness is measured strictly against the default POSE_IDS set — never a
// raw pose count, so custom poses can't inflate it.

function poseIdsOf(metaOrPoseIds: BuddyMeta | Iterable<string>): Set<string> {
  if (
    metaOrPoseIds &&
    typeof metaOrPoseIds === "object" &&
    "poses" in metaOrPoseIds
  ) {
    return new Set(Object.keys((metaOrPoseIds as BuddyMeta).poses ?? {}));
  }
  return new Set(metaOrPoseIds as Iterable<string>);
}

/** The default POSE_IDS a buddy is missing — [] means every standard pose present. */
export function missingDefaultPoses(
  metaOrPoseIds: BuddyMeta | Iterable<string>,
): Array<PoseId> {
  const present = poseIdsOf(metaOrPoseIds);
  return POSE_IDS.filter((id) => !present.has(id));
}

/** True when every default POSE_IDS pose is present (custom poses are ignored). */
export function hasAllDefaultPoses(
  metaOrPoseIds: BuddyMeta | Iterable<string>,
): boolean {
  return missingDefaultPoses(metaOrPoseIds).length === 0;
}

// ---- Augment primitive -----------------------------------------------------

/**
 * Add (or replace) a custom pose clip in a packed .buddy, returning new bytes.
 * Reads meta through the one parse path, writes the clip as `<id>.mp4`, removes
 * any prior clip for that id even if stored under a different filename, upserts
 * the `customPoses` def without duplicating, preserves all other zip entries,
 * and repacks through packBuddy (so the version stamp and referential check
 * apply). A def whose id collides with a standard POSE_IDS is rejected.
 *
 * The clip is written as `<id>.<clipExt>` (default `'mp4'`). Pass `clipExt:
 * 'webm'` for a transparent buddy's matted clip — note packBuddy's transparent
 * honesty check then requires an alpha-capable extension, so adding an mp4 clip
 * to a transparent buddy will (intentionally) throw at pack time.
 */
export function addPoseToBuddy(
  bytes: Uint8Array,
  def: CustomPoseDef,
  clipBytes: Uint8Array,
  opts?: { clipExt?: string },
): Uint8Array {
  if ((POSE_IDS as ReadonlyArray<string>).includes(def.id)) {
    throw new BuddyFormatError(
      `addPoseToBuddy: "${def.id}" is a standard pose id; custom poses must use a non-standard (app-prefixed) id`,
    );
  }

  const files = unzipSync(bytes);
  if (!files["metadata.json"])
    throw new BuddyFormatError("metadata.json missing from .buddy file");
  const meta = parseBuddyMetaBytes(files["metadata.json"]);

  // Drop any prior clip for this id (whatever filename it used), plus the
  // manifest itself — everything else is preserved payload.
  const priorClip = meta.poses?.[def.id];
  const clipExt = (opts?.clipExt ?? "mp4").replace(/^\./, "");
  const clipName = `${def.id}.${clipExt}`;
  const assets: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) {
    if (name === "metadata.json") continue;
    if (name === priorClip || name === clipName) continue;
    assets[name] = data;
  }
  assets[clipName] = clipBytes;

  const poses = { ...(meta.poses ?? {}), [def.id]: clipName };
  const existing = meta.customPoses ?? [];
  const customPoses = existing.some((c) => c.id === def.id)
    ? existing.map((c) => (c.id === def.id ? { ...c, ...def } : c))
    : [...existing, def];

  return packBuddy({ ...meta, poses, customPoses }, assets);
}

/** Decode a data URI into { ext, bytes } for packing into a .buddy. */
export function dataUriToBytes(
  uri: string,
): { ext: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  const ext = extMap[mime] ?? mime.split("/")[1] ?? "bin";
  const bin = atob(m[3] || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ext, bytes };
}
