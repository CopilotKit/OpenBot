/** The largest decoded avatar OpenBot stores in PostgreSQL. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** A small enough ceiling that a compressed image cannot make the browser allocate an absurd bitmap. */
const MAX_AVATAR_EDGE = 4096;
const MAX_AVATAR_PIXELS = 16_777_216;

const DATA_URL =
  /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export type AvatarImageResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Validate an uploaded avatar at the trust boundary.
 *
 * The browser sends a data URL because avatars are small and the database is shared by every
 * server replica. The MIME label is not trusted: the decoded bytes must carry the matching image
 * signature, and dimensions are bounded before any browser is asked to decode them.
 */
export function parseAvatarImage(value: unknown): AvatarImageResult {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return {
      ok: false,
      error: "Avatar image must be a PNG, JPEG, or WebP file.",
    };
  }

  const match = DATA_URL.exec(value);
  if (!match || match[2].length % 4 !== 0) {
    return {
      ok: false,
      error: "Avatar image must be a PNG, JPEG, or WebP file.",
    };
  }

  const mime = match[1];
  const encoded = match[2];
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_AVATAR_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    return {
      ok: false,
      error: `Avatar image must be ${MAX_AVATAR_BYTES / 1024 / 1024} MB or smaller.`,
    };
  }

  const dimensions = imageDimensions(mime, bytes);
  if (!dimensions) {
    return {
      ok: false,
      error: "Avatar image does not match its PNG, JPEG, or WebP format.",
    };
  }
  if (
    dimensions.width > MAX_AVATAR_EDGE ||
    dimensions.height > MAX_AVATAR_EDGE ||
    dimensions.width * dimensions.height > MAX_AVATAR_PIXELS
  ) {
    return {
      ok: false,
      error: `Avatar image dimensions must be at most ${MAX_AVATAR_EDGE} by ${MAX_AVATAR_EDGE} pixels.`,
    };
  }

  return { ok: true, value };
}

/** A stable, cache-busting URL without copying the image into every JSON response. */
export function avatarUrl(
  path: string,
  versionSource: string | Date | null,
): string | null {
  if (!versionSource) return null;
  if (versionSource instanceof Date) {
    return `${path}?v=${versionSource.getTime().toString(36)}`;
  }
  // FNV-1a is not a security claim, just a cheap content version. A collision costs one stale cache.
  let version = 0x811c9dc5;
  for (let index = 0; index < versionSource.length; index += 1) {
    version ^= versionSource.charCodeAt(index);
    version = Math.imul(version, 0x01000193);
  }
  return `${path}?v=${(version >>> 0).toString(36)}`;
}

/** Serve one already-validated image at its versioned authenticated URL. */
export function avatarResponse(image: string): Response {
  const match = DATA_URL.exec(image);
  if (!match) return new Response("Avatar not found.", { status: 404 });
  return new Response(new Uint8Array(Buffer.from(match[2], "base64")), {
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
      "content-type": match[1],
      "x-content-type-options": "nosniff",
    },
  });
}

function imageDimensions(
  mime: string,
  bytes: Buffer,
): { width: number; height: number } | null {
  if (mime === "image/png") return pngDimensions(bytes);
  if (mime === "image/jpeg") return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

function pngDimensions(bytes: Buffer) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegDimensions(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (startOfFrame.has(marker)) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Buffer) {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    const width = 1 + readUInt24LE(bytes, 24);
    const height = 1 + readUInt24LE(bytes, 27);
    return { width, height };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    const width = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8));
    const height =
      1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10));
    return { width, height };
  }
  if (
    kind === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
