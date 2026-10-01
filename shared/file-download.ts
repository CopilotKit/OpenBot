/**
 * The response contract for a workspace file leaving the computer.
 *
 * Downloads are always opaque attachments. A generated HTML, SVG or JavaScript file must not be
 * rendered on the application's origin, and an extension is not evidence of what the bytes contain.
 * One declaration is shared by the computer that reads the file and the server that exposes it, so
 * the two sides cannot drift on whether inline rendering is allowed.
 */

export const DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

function headerSafeFilename(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    // Header injection is removed before any quoting: a quote or backslash would otherwise escape
    // the quoted parameter and let a filename carry its own directive.
    return code <= 0x1f ||
      code === 0x7f ||
      character === '"' ||
      character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .trim();
  // Keep the fallback and RFC 5987 form bounded. A filename is a label, not a transport for an
  // unbounded path.
  return Array.from(cleaned).slice(0, 255).join("") || "download";
}

function asciiFallback(name: string): string {
  const fallback = Array.from(name, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e ? character : "_";
  }).join("");
  return fallback || "download";
}

function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contentDisposition(name: string): string {
  const safe = headerSafeFilename(name);
  return `attachment; filename="${asciiFallback(safe)}"; filename*=UTF-8''${rfc5987Encode(safe)}`;
}

export function downloadHeaders(
  name: string,
  bytes: number,
): Record<string, string> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("A download must have a non-negative byte length.");
  }
  return {
    "Content-Type": DOWNLOAD_CONTENT_TYPE,
    "Content-Length": String(bytes),
    "Content-Disposition": contentDisposition(name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}
