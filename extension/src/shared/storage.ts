import type {
  RecorderConnectVia,
  RecorderMe,
  RecorderUser,
} from "@openbot/shared/recorder-api";
import type { RecorderState, StreamSession } from "../protocol/messages";
export type ConnectionRecord = {
  openbotUrl: string;
  token: string;
  connectionId: string;
  user: RecorderUser;
  via: RecorderConnectVia;
  connectedAt: number;
};
/** What a stopped recording's streamer reported when it stopped with events kept (Decision 19, Task 11's offscreen.kept),
 * or, with `waitingForReconnect`, that the connection was signed out and the recording waits for its person to connect again. */
export type KeptEvents = {
  reason: string;
  parked: boolean;
  events: number;
  at: number;
  waitingForReconnect?: boolean;
};
/** A recording whose queued steps, events, voice or media may still need sending. */
export type DrainRecord = {
  demonstrationId: string;
  botId: string;
  title: string;
  openbotUrl: string;
  /** The person who recorded it: its data is sent only while that person is connected to `openbotUrl` (Decision 19). */
  userId: string;
  userName: string;
  trajectoryIds: string[];
  startedAt: number;
  /** Stop has not yet reached OpenBot (its steps were still uploading, or OpenBot did not answer): recovery and the next
   * reconnect upload the queued steps first and then send `POST .../stop` (Task 9). */
  stopPending?: boolean;
  /** Start over: delete this demonstration once its outbox has drained. */
  discard: boolean;
  /** Set while its events are kept after a stop (hold) or stop (park) row, or while it waits for its person to connect
   * again; cleared on offscreen.done. */
  kept?: KeptEvents;
};
export type RecorderNotice =
  | { kind: "interrupted"; at: number }
  | {
      kind: "signed-out";
      at: number;
      reason?: "revoked" | "removed" | "organization";
    }
  | { kind: "policy-moved"; at: number; origin: string };
export type LocalState = {
  /** Random per installed copy (each browser and profile has its own), written on install or first use (Decision 18). */
  installSecret?: string;
  connection?: ConnectionRecord;
  lastBotId?: string;
  activeRecording?: DrainRecord; // the recording in progress; moved into `drains` at Stop and on recovery
  drains?: DrainRecord[]; // stopped recordings still sending; removed on offscreen.done
  notice?: RecorderNotice;
  /** When the organization-session keep-alive last reached OpenBot (Decision 2, Task 8). */
  lastKeepAliveAt?: number;
};
export type PendingConnect = {
  origin: string;
  code: string;
  via: RecorderConnectVia;
  requestedAt: number;
  tabId?: number;
};
export type SessionState = {
  recorder: RecorderState;
  pendingConnect?: PendingConnect;
  stream?: StreamSession; // so a restarted service worker can resume the offscreen document
  me?: { value: RecorderMe; fetchedAt: number };
  /** Sensitive-value digests of the recording in progress. Memory only (storage.session is never written to disk
   * and is not readable by content scripts by default), so they survive a service-worker restart and vanish with
   * the browser; cleared at Stop. Never written to storage.local or IndexedDB. */
  digests?: string[];
  /** openbot.connect requests per origin in the last 10 minutes (timestamps), for Decision 22's limit (Task 8). */
  connectRequests?: Record<string, number[]>;
};
export async function readLocal<K extends keyof LocalState>(
  key: K,
): Promise<LocalState[K]> {
  const items = await chrome.storage.local.get(key);
  return items[key] as LocalState[K];
}
export async function writeLocal<K extends keyof LocalState>(
  key: K,
  value: NonNullable<LocalState[K]>,
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}
export async function removeLocal(key: keyof LocalState): Promise<void> {
  await chrome.storage.local.remove(key);
}
export async function readSession<K extends keyof SessionState>(
  key: K,
): Promise<SessionState[K] | undefined> {
  const items = await chrome.storage.session.get(key);
  return items[key] as SessionState[K] | undefined;
}
export async function writeSession<K extends keyof SessionState>(
  key: K,
  value: NonNullable<SessionState[K]>,
): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}
export async function removeSession(key: keyof SessionState): Promise<void> {
  await chrome.storage.session.remove(key);
}
/** Keeps the bearer token out of content scripts: storage.local defaults to readable by them. */
export async function restrictStorageToTrustedContexts(): Promise<void> {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
}
/** Reads `installSecret`, creating it with crypto.randomUUID() when absent. */
export async function installSecret(): Promise<string> {
  const existing = await readLocal("installSecret");
  if (existing) return existing;
  const created = crypto.randomUUID();
  await writeLocal("installSecret", created);
  return created;
}
/** This copy's install id for one OpenBot origin: the first 32 hex digits of SHA-256(installSecret + "\n" + origin),
 * so it is stable per (copy, origin) and links nothing across sites (Decision 18). */
export async function installIdFor(origin: string): Promise<string> {
  const secret = await installSecret();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}\n${origin}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 32);
}
