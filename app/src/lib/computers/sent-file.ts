/**
 * A file a Bot sent from its computer into the conversation, as its tool call's answer carries it.
 *
 * `computer_send_file` answers `{ ok: true, file: { attachmentId, name, mimeType, sizeBytes, url } }`.
 * The server stored the file as an attachment of the conversation, so the card reads everything it
 * draws from this answer: a reopened conversation shows the same card from the stored answer alone,
 * and every member of the conversation reads the file from the same address.
 */
export type SentFile = {
  attachmentId: string;
  name: string;
  /** The type the server found in the bytes, which it serves the file as. */
  mimeType: string;
  sizeBytes: number;
  /** The stored form every message uses, `/api/attachments/<id>`. */
  url: string;
};

/** The file in a `computer_send_file` answer, or null when the answer carries none. */
export function sentFileOf(answer: unknown): SentFile | null {
  if (!answer || typeof answer !== "object") return null;
  const { ok, file } = answer as { ok?: unknown; file?: unknown };
  if (ok !== true || !file || typeof file !== "object") return null;
  const { attachmentId, name, mimeType, sizeBytes, url } = file as Record<
    string,
    unknown
  >;
  if (
    typeof attachmentId !== "string" ||
    !attachmentId ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof url !== "string"
  )
    return null;
  return { attachmentId, name, mimeType, sizeBytes, url };
}

/** A size as a person reads it: 820 bytes, 14 KB, 2.3 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/** What the card calls a file's kind, from the type the server found. */
export function kindLabel(mimeType: string, name: string): string {
  const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "application/pdf") return "PDF";
  if (type === "text/csv") return "CSV";
  if (type === "application/json") return "JSON";
  if (type === "text/markdown") return "Markdown";
  if (type.startsWith("image/")) return `${type.slice(6).toUpperCase()} image`;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : "Text file";
}
