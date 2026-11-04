// server/tests/support/files.ts
//
// Attachments and page frames for the tests, in a real Intelligence.
//
// They live in Intelligence's file store, so a test that needs one makes it there, through the same
// client the server uses, and reads it back the way the server does. There is no stand-in: a fake
// store that passed while the real one refused would be exactly the test that lies.
//
// WHICH INTELLIGENCE. The one `testIntelligence()` (support/bots.ts) names, from
// `TEST_INTELLIGENCE_API_URL` and `TEST_INTELLIGENCE_API_KEY`. Missing, every test that touches a
// file fails here and says so, rather than skipping and reporting a pass for a suite that never ran.
import {
  createFilesClient,
  type FilesClient,
  filesClient,
  installFilesClient,
  type StoredFile,
} from "../../src/files/client";
import { testIntelligence } from "./bots";

let installed: FilesClient | undefined;

/** The process's file store, against the test Intelligence, installed. Once per process. */
export function useTestFiles(): FilesClient {
  if (!installed) {
    const intelligence = testIntelligence();
    installed = installFilesClient(
      createFilesClient({
        apiUrl: intelligence.apiUrl,
        apiKey: intelligence.apiKey,
      }),
    );
  }
  return installed;
}

/**
 * Puts the test Intelligence's client back, for a test that installed one pointed elsewhere (an
 * unreachable Intelligence, say) to see how the server answers when it cannot be reached.
 */
export function restoreTestFiles(): void {
  installed = undefined;
  useTestFiles();
}

/** A client whose every request fails to connect: Intelligence down. */
export function unreachableFiles(): FilesClient {
  return installFilesClient(
    createFilesClient({
      // Port 9 (discard) on loopback: nothing listens, so every request is refused at once.
      apiUrl: "http://127.0.0.1:9",
      apiKey: "cpk_unreachable_unreachable",
    }),
  );
}

/** An attachment as Intelligence holds it, or null. */
export async function attachmentInIntelligence(
  id: string,
): Promise<StoredFile | null> {
  return filesClient().get(id);
}

/** Every attachment Intelligence holds in one channel. */
export async function attachmentsInChannel(
  channelId: string,
): Promise<StoredFile[]> {
  return filesClient().list({
    purpose: "chat_attachment",
    collection: channelId,
  });
}

/**
 * An attachment made directly in Intelligence, the way an upload or the upgrade copy leaves one:
 * for a test that needs one in a state no route produces (sent long ago, staged by someone else).
 */
export async function seedAttachment(input: {
  channelId: string;
  uploadedBy: string;
  name?: string;
  mimeType?: string;
  bytes?: Uint8Array;
  uploadGroup?: string | null;
  attachedAt?: Date | null;
  createdAt?: Date;
  expiresAt?: Date | null;
  id?: string;
}): Promise<string> {
  const { file } = await filesClient().create(
    {
      ...(input.id ? { id: input.id } : {}),
      purpose: "chat_attachment",
      ownerUserId: input.uploadedBy,
      collection: input.channelId,
      batch: input.uploadGroup ?? null,
      name: input.name ?? "notes.txt",
      contentType: input.mimeType ?? "text/plain",
      committed: Boolean(input.attachedAt),
      ...(input.attachedAt ? { committedAt: input.attachedAt } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      expiresAt: input.expiresAt ?? null,
    },
    input.bytes ?? new TextEncoder().encode("hello"),
    `test:${crypto.randomUUID()}`,
  );
  return file.id;
}

/** Removes every attachment in a channel, as a test cleans up after itself. */
export async function clearChannelAttachments(
  channelId: string,
): Promise<void> {
  await filesClient().purge({
    purpose: "chat_attachment",
    collection: channelId,
  });
}
