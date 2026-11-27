import type { Attachment } from "@copilotkit/react-core/v2";
import type { Segment } from "prompt-area/helpers";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { currentOrganizationId } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { stagedRowId } from "./attachments";

/**
 * AN UNSENT MESSAGE, KEPT PER CONVERSATION IN THIS BROWSER.
 *
 * Switching conversations remounts the composer, and a reload empties the page, so without this a
 * half-written reply and the files staged for it were gone the moment somebody looked at another
 * conversation. What is kept, under the organization, the person and the conversation:
 *
 * - the words, with their `@` and `/` chips, as the editor holds them;
 * - the files already uploaded for the message (their stored rows, which the server holds unsent
 *   for a day), and the upload group they were staged in, so the server keeps counting the same set;
 * - on a screen with no conversation yet, the picked files themselves, which have not been uploaded
 *   anywhere (`heldAttachmentsConfig`): in memory for this visit, and in IndexedDB for a reload.
 *
 * Sending clears it, because sending empties the composer. Nothing here talks to the server.
 */

const PREFIX = "openbot:composer-draft:";

/** How long the server holds a file staged for a message that was never sent (the upload's own docs). */
export const STAGED_FILE_HELD_MS = 24 * 60 * 60 * 1000;

/** A draft nobody has come back to for this long is dropped, so the browser does not keep them forever. */
const FORGOTTEN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** A file already uploaded for this message: enough to draw its chip and send it, never its bytes. */
export type SavedStagedFile = {
  attachmentId: string;
  /** The `url` source the upload answered with. */
  url: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  /** When it was uploaded, to tell whether the server can still be holding it. */
  stagedAt: number;
};

export type SavedDraft = {
  segments: Segment[];
  uploadGroup?: string;
  staged: SavedStagedFile[];
  /** Files held in this browser for a screen with no conversation yet; their bytes are kept apart. */
  heldFiles: number;
  savedAt: number;
};

/**
 * Where one conversation's draft is kept, or undefined when the organization or the person is not
 * known yet: a draft is somebody's, and is never written where another person could open it.
 */
export function savedDraftKey(draftKey: string): string | undefined {
  return personalKey(PREFIX, draftKey);
}

/** `name` under `prefix`, for this person in this organization; undefined until both are known. */
function personalKey(prefix: string, name: string): string | undefined {
  const organization = currentOrganizationId();
  const person = queryClient.getQueryData<AuthenticatedUser>(
    authKeys.currentUser(),
  )?.id;
  if (!organization || !person) return undefined;
  return `${prefix}${encodeURIComponent(organization)}:${encodeURIComponent(person)}:${encodeURIComponent(name)}`;
}

const SENDING_PREFIX = "openbot:composer-sending:";

/**
 * A NEW CONVERSATION'S BOX WHOSE SEND HAD NOT YET MADE ITS CONVERSATION. Each visit to a new
 * conversation keeps its draft under a name of its own, so a page that died while its Send was
 * still making the conversation left the words under a name no later visit asks for. This is that
 * name, kept until the conversation is made, for the next new conversation to open with
 * (`sendingDraftLeftBehind`).
 */
export function rememberSendingDraft(group: string, draftKey: string) {
  const key = personalKey(SENDING_PREFIX, group);
  if (!key) return;
  try {
    window.localStorage.setItem(key, draftKey);
  } catch {
    /* Without storage the words last as long as the page. */
  }
}

/** The Send from `group` made its conversation, or gave its words back to the box: nothing is left behind. */
export function forgetSendingDraft(group: string) {
  const key = personalKey(SENDING_PREFIX, group);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Nothing was kept. */
  }
}

/** The draft a page of `group` left behind when it died mid-Send, if its words are still kept. */
export function sendingDraftLeftBehind(group: string): string | undefined {
  const key = personalKey(SENDING_PREFIX, group);
  if (!key) return undefined;
  try {
    const draftKey = window.localStorage.getItem(key);
    if (!draftKey) return undefined;
    const saved = savedDraftKey(draftKey);
    if (saved && readSavedDraft(saved)) return draftKey;
    window.localStorage.removeItem(key);
    return undefined;
  } catch {
    return undefined;
  }
}

export function readSavedDraft(key: string): SavedDraft | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const draft = parseDraft(JSON.parse(raw));
    if (!draft || Date.now() - draft.savedAt > FORGOTTEN_AFTER_MS) {
      window.localStorage.removeItem(key);
      return undefined;
    }
    return draft;
  } catch {
    return undefined;
  }
}

/** Keep `draft` under `key`, or forget it when there is nothing in it. */
export function writeSavedDraft(key: string, draft: SavedDraft | undefined) {
  try {
    if (!draft || isEmptyDraft(draft)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(draft));
    forgetOldDrafts();
  } catch {
    /* Storage can be full or turned off; the draft then lasts as long as the composer does. */
  }
}

/** Forget the draft a box keeps under `draftKey` (the composer's own name for it). */
export function forgetSavedDraft(draftKey: string) {
  const key = savedDraftKey(draftKey);
  if (!key) return;
  writeSavedDraft(key, undefined);
  saveHeldFiles(key, []);
}

function isEmptyDraft(draft: SavedDraft): boolean {
  const words = draft.segments.some((segment) =>
    segment.type === "chip" ? true : segment.text.trim().length > 0,
  );
  return !words && draft.staged.length === 0 && draft.heldFiles === 0;
}

let swept = false;
/** Once a visit: drop drafts nobody has come back to in a long while. */
function forgetOldDrafts() {
  if (swept) return;
  swept = true;
  for (let index = window.localStorage.length - 1; index >= 0; index--) {
    const name = window.localStorage.key(index);
    if (!name?.startsWith(PREFIX)) continue;
    readSavedDraft(name);
  }
}

/** The stored file an attachment on the strip stands for, or undefined if it has none yet. */
export function toSavedStagedFile(
  attachment: Attachment,
  stagedAt: number,
): SavedStagedFile | undefined {
  const attachmentId = stagedRowId(attachment);
  const { source } = attachment;
  if (
    attachmentId === undefined ||
    attachment.status !== "ready" ||
    source.type !== "url"
  )
    return undefined;
  return {
    attachmentId,
    url: source.value,
    ...(source.mimeType ? { mimeType: source.mimeType } : {}),
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    stagedAt,
  };
}

/** Whether the server can still be holding a file staged at `stagedAt`. */
export function stillHeld(file: SavedStagedFile, now = Date.now()): boolean {
  return now - file.stagedAt < STAGED_FILE_HELD_MS;
}

function parseDraft(value: unknown): SavedDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const draft = value as Record<string, unknown>;
  if (
    !Array.isArray(draft.segments) ||
    !Array.isArray(draft.staged) ||
    typeof draft.savedAt !== "number"
  )
    return undefined;
  const segments = draft.segments.filter(isSegment);
  const staged = draft.staged.filter(isSavedStagedFile);
  return {
    segments,
    ...(typeof draft.uploadGroup === "string" && draft.uploadGroup
      ? { uploadGroup: draft.uploadGroup }
      : {}),
    staged,
    heldFiles: typeof draft.heldFiles === "number" ? draft.heldFiles : 0,
    savedAt: draft.savedAt,
  };
}

function isSegment(value: unknown): value is Segment {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  if (segment.type === "text") return typeof segment.text === "string";
  return (
    segment.type === "chip" &&
    typeof segment.trigger === "string" &&
    typeof segment.value === "string" &&
    typeof segment.displayText === "string"
  );
}

function isSavedStagedFile(value: unknown): value is SavedStagedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.attachmentId === "string" &&
    file.attachmentId.length > 0 &&
    typeof file.url === "string" &&
    typeof file.stagedAt === "number"
  );
}

/*
 * HELD FILES: the bytes of files picked on a screen with no conversation yet. They cannot go in
 * `localStorage`, so this visit keeps them in memory and a reload reads them back from IndexedDB.
 * Either can be missing (a private window, a browser that refuses storage); the words still come
 * back, and the files are simply not offered again.
 */
const heldInMemory = new Map<string, File[]>();
const DATABASE = "openbot-composer-drafts";
const STORE = "held-files";

function openDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(undefined);
        return;
      }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function inStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        database.close();
        resolve(request.result);
      };
      transaction.onerror = () => {
        database.close();
        resolve(undefined);
      };
      transaction.onabort = () => {
        database.close();
        resolve(undefined);
      };
    } catch {
      database.close();
      resolve(undefined);
    }
  });
}

/**
 * A held file as IndexedDB keeps it: its bytes and what names them. Not the `File` itself, which
 * WebKit refuses to store in a private window, while it stores the bytes.
 */
type StoredFile = {
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
};

/** Each key's writes, one after another, so a slower earlier write never lands over a later one. */
const writes = new Map<string, Promise<unknown>>();

function inOrder(key: string, write: () => Promise<unknown>) {
  const next = (writes.get(key) ?? Promise.resolve()).then(write, write);
  writes.set(key, next);
  void next.finally(() => {
    if (writes.get(key) === next) writes.delete(key);
  });
}

/** Keep the held files of the draft under `key`; an empty list forgets them. */
export function saveHeldFiles(key: string, files: readonly File[]) {
  if (files.length === 0) {
    heldInMemory.delete(key);
    inOrder(key, () => inStore("readwrite", (store) => store.delete(key)));
    return;
  }
  heldInMemory.set(key, [...files]);
  inOrder(key, async () => {
    let stored: StoredFile[];
    try {
      stored = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          bytes: await file.arrayBuffer(),
        })),
      );
    } catch {
      return;
    }
    await inStore("readwrite", (store) => store.put(stored, key));
  });
}

/** The held files kept for `key`: this visit's when there are any, else the ones kept for a reload. */
export async function loadHeldFiles(key: string): Promise<File[]> {
  const remembered = heldInMemory.get(key);
  if (remembered) return remembered;
  await writes.get(key);
  const stored = await inStore<unknown>("readonly", (store) => store.get(key));
  if (!Array.isArray(stored)) return [];
  return stored.filter(isStoredFile).map(
    (file) =>
      new File([file.bytes], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      }),
  );
}

function isStoredFile(value: unknown): value is StoredFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.name === "string" &&
    typeof file.type === "string" &&
    typeof file.lastModified === "number" &&
    file.bytes instanceof ArrayBuffer
  );
}

/** For a test: forget this visit's memory, as a reload would. */
export function forgetHeldFilesInMemory() {
  heldInMemory.clear();
}
