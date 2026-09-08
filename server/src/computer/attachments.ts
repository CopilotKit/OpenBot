import { createHash, randomUUID } from "node:crypto";
import type { ComputerProvider } from "./provider";
import { checkComputerAddress } from "./target";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HANDOFF_BYTES = 25 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export type HandoffAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  path: string;
};

export type ExportedAttachment = Omit<HandoffAttachment, "id" | "path"> & {
  bytes: Buffer;
};

export type ComputerAttachmentBroker = {
  copy(input: {
    handoffId: string;
    fromBotId: string;
    toBotId: string;
    paths: string[];
  }): Promise<HandoffAttachment[]>;
  read(input: { botId: string; path: string }): Promise<ExportedAttachment>;
  remove(input: {
    botId: string;
    handoffId: string;
    attachment: HandoffAttachment;
  }): Promise<{ deleted: boolean }>;
};

export function createComputerAttachmentBroker(options: {
  provider: ComputerProvider;
  token?: string;
  fetchImpl?: typeof fetch;
  id?: () => string;
}): ComputerAttachmentBroker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nextId = options.id ?? randomUUID;

  async function endpoint(botId: string, path: string): Promise<string> {
    const base = await options.provider.locate(botId);
    const verdict = checkComputerAddress(base);
    if (!verdict.allowed) throw new Error(verdict.reason);
    return `${base.replace(/\/$/, "")}${path}`;
  }

  async function request(
    botId: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(await endpoint(botId, path), {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          "x-openbot-bot-id": botId,
          ...(options.token
            ? { "x-openbot-computer-token": options.token }
            : {}),
        },
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new Error("The assistant's computer is not running.");
    }
    if (!response.ok) {
      throw new Error(
        `The assistant's computer refused a file transfer (${response.status}).`,
      );
    }
    return response;
  }

  async function remove(input: {
    botId: string;
    handoffId: string;
    attachment: HandoffAttachment;
  }): Promise<{ deleted: boolean }> {
    const response = await request(input.botId, "/files/attachments/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handoffId: input.handoffId,
        attachmentId: input.attachment.id,
        filename: input.attachment.filename,
        mediaType: input.attachment.mediaType,
        sizeBytes: input.attachment.sizeBytes,
        sha256: input.attachment.sha256,
      }),
    });
    const result = (await response.json()) as { deleted?: unknown };
    return { deleted: result.deleted === true };
  }

  async function read(input: {
    botId: string;
    path: string;
  }): Promise<ExportedAttachment> {
    const exported = await request(input.botId, "/files/attachments/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: input.path }),
    });
    const sizeBytes = parseSize(exported.headers.get("content-length"));
    const filename = decodeFilename(
      exported.headers.get("x-openbot-attachment-filename"),
    );
    const mediaType = exported.headers.get("content-type") ?? "";
    const sha256 = exported.headers.get("x-openbot-attachment-sha256") ?? "";
    if (!SHA256.test(sha256)) throw new Error("Invalid attachment hash.");
    const bytes = Buffer.from(await exported.arrayBuffer());
    if (
      bytes.length !== sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new Error("The attachment changed during transfer.");
    }
    return { bytes, filename, mediaType, sizeBytes, sha256 };
  }

  return {
    async copy(input) {
      if (input.paths.length < 1 || input.paths.length > MAX_FILES) {
        throw new Error(`A handoff accepts between 1 and ${MAX_FILES} files.`);
      }
      if (!/^[a-f0-9]{64}$/.test(input.handoffId)) {
        throw new Error("Invalid handoff id.");
      }

      const copied: HandoffAttachment[] = [];
      let totalBytes = 0;
      try {
        for (const path of input.paths) {
          const attachmentId = nextId();
          const exported = await read({ botId: input.fromBotId, path });
          const { sizeBytes, filename, mediaType, sha256, bytes } = exported;
          totalBytes += sizeBytes;
          if (totalBytes > MAX_HANDOFF_BYTES) {
            throw new Error(
              "The attached files exceed the handoff byte limit.",
            );
          }
          const imported = await request(
            input.toBotId,
            "/files/attachments/import",
            {
              method: "POST",
              headers: {
                "content-type": mediaType,
                "content-length": String(sizeBytes),
                "x-openbot-handoff-id": input.handoffId,
                "x-openbot-attachment-id": attachmentId,
                "x-openbot-attachment-filename": encodeURIComponent(filename),
                "x-openbot-attachment-sha256": sha256,
              },
              body: new Uint8Array(bytes),
            },
          );
          const received = (await imported.json()) as Record<string, unknown>;
          const attachment: HandoffAttachment = {
            id: attachmentId,
            filename,
            mediaType,
            sizeBytes,
            sha256,
            path: expectedPath(input.handoffId, attachmentId, filename),
          };
          if (
            received.attachmentId !== attachment.id ||
            received.filename !== attachment.filename ||
            received.mediaType !== attachment.mediaType ||
            received.sizeBytes !== attachment.sizeBytes ||
            received.sha256 !== attachment.sha256 ||
            received.path !== attachment.path
          ) {
            throw new Error(
              "The target computer returned a mismatched attachment receipt.",
            );
          }
          copied.push(attachment);
        }
        return copied;
      } catch (error) {
        await Promise.allSettled(
          copied.map((attachment) =>
            remove({
              botId: input.toBotId,
              handoffId: input.handoffId,
              attachment,
            }),
          ),
        );
        throw error;
      }
    },
    read,
    remove,
  };
}

function parseSize(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error("Invalid attachment size.");
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    throw new Error("Invalid attachment size.");
  }
  return size;
}

function decodeFilename(raw: string | null): string {
  if (!raw) throw new Error("Missing attachment filename.");
  let filename: string;
  try {
    filename = decodeURIComponent(raw);
  } catch {
    throw new Error("Invalid attachment filename.");
  }
  if (!filename || filename.length > 255 || /[\\/]/.test(filename)) {
    throw new Error("Invalid attachment filename.");
  }
  return filename;
}

function expectedPath(
  handoffId: string,
  attachmentId: string,
  filename: string,
): string {
  return `inbox/${handoffId}/${attachmentId}/${filename}`;
}
