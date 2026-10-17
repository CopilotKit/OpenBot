import type { MediaRecord } from "@openbot/shared/recorder-api";
import type { Database } from "../db/client";

export class DemonstrationMediaUnavailableError extends Error {
  constructor() {
    super("Recordings' media is not available yet.");
    this.name = "DemonstrationMediaUnavailableError";
  }
}

export type DemonstrationMediaStore = {
  create(
    ownerUserId: string,
    demonstrationId: string,
    input: { kind: "screen" | "audio" | "network"; mimeType: string },
  ): Promise<MediaRecord>;
  putChunk(
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<MediaRecord>;
  get(
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
  ): Promise<MediaRecord>;
  complete(
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
    chunkCount: number,
  ): Promise<MediaRecord>;
  /** Read side for the cookie routes (no owner check here; the routes check owner-or-administrator first). */
  list(demonstrationId: string): Promise<MediaRecord[]>;
  content(
    demonstrationId: string,
    mediaId: string,
  ): Promise<{ mimeType: string; chunks: AsyncIterable<Uint8Array> } | null>;
  line(
    demonstrationId: string,
    mediaId: string,
    line: number,
  ): Promise<string | null>;
};

export function createDemonstrationMediaStore(
  _database: Database,
): DemonstrationMediaStore {
  const off = async (): Promise<never> => {
    throw new DemonstrationMediaUnavailableError();
  };
  return {
    create: off,
    putChunk: off,
    get: off,
    complete: off,
    list: off,
    content: off,
    line: off,
  };
}
