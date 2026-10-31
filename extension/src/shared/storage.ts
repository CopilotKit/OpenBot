import type { Narration } from "@openbot/shared/openbot-browser";
import type {
  LearningSpaceState,
  RecorderConnectVia,
  RecorderMe,
  RecorderUser,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type { AgentSnapshot } from "../background/agent/events";
import type { StepSnapshot } from "../background/steps";
import type { RecorderState, StreamSession } from "../protocol/messages";
import { normaliseSites } from "./sites";
export type ConnectionRecord = {
  openbotUrl: string;
  token: string;
  connectionId: string;
  user: RecorderUser;
  via: RecorderConnectVia;
  connectedAt: number;
  /** Who hears the person, for a connection the Recorder's launcher made (launcher.ts): `external` when the browser has
   * no microphone and OpenBot passes each phrase in. Absent: the Recorder hears the microphone itself, as always. */
  narration?: Narration;
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
/** A recording whose events may still need sending to Intelligence. A recording exists only in this browser and in
 * Intelligence: `recordingId` is the Recorder's own id for it, and `trajectoryIds` its trajectories in Intelligence,
 * each in its person's own Learning space. */
export type DrainRecord = {
  recordingId: string;
  title: string;
  /** The OpenBot that hands out its capture passes. */
  openbotUrl: string;
  /** The person who recorded it: its events are sent only while that person is connected to `openbotUrl` (Decision 19). */
  userId: string;
  userName: string;
  trajectoryIds: string[];
  startedAt: number;
  /** The person chose to discard it (Discard kept events, Disconnect): nothing of it is ever sent, and a restart that
   * interrupted the clearing finishes it. */
  discarding?: boolean;
  /** Set while its events are kept after a stop (hold) or stop (park) row, or while it waits for its person to connect
   * again; cleared on offscreen.done. */
  kept?: KeptEvents;
  /** The steps its service worker still held when the browser quit (`heldSteps`), as they are sent: the document that
   * recovers it puts them in its outbox before the interrupted outcome, and says so (offscreen.held). */
  held?: HeldEvent[];
};
/** A held step as it is sent, with its key (steps.ts `Pending.key`): the document stores a key once, so a step that left
 * before the browser quit, which the held steps in storage may still list, is never sent again. */
export type HeldEvent = { event: CapturedEvent; key?: string };
/** The steps the live recording's service worker holds (steps.ts), written as they change: a service worker that
 * restarts takes them up again, and after a browser quit they go with the recording's drain. The events are masked
 * already, as the outbox stores them. */
export type HeldSteps = {
  recordingId: string;
  steps: StepSnapshot;
  /** What the recording's agent events know that a click's Thread context and the links depend on (agent/events.ts),
   * in the same write as the steps, so the two never disagree on what has left: ids and times only. */
  agent?: AgentSnapshot;
};
export type RecorderNotice =
  | { kind: "interrupted"; at: number }
  | {
      kind: "signed-out";
      at: number;
      reason?: "revoked" | "removed" | "organization";
    }
  | { kind: "policy-moved"; at: number; origin: string };
type LocalState = {
  /** Random per installed copy (each browser and profile has its own), written on install or first use (Decision 18). */
  installSecret?: string;
  connection?: ConnectionRecord;
  activeRecording?: DrainRecord; // the recording in progress; moved into `drains` at Stop, Start over and on recovery
  drains?: DrainRecord[]; // stopped recordings still sending; removed on offscreen.done
  heldSteps?: HeldSteps; // the live recording's held steps and agent context; absent while it holds neither
  notice?: RecorderNotice;
  /** When the organization-session keep-alive last reached OpenBot (Decision 2, Task 8). */
  lastKeepAliveAt?: number;
  /** Whether the person narrates their recordings, as they chose on the setup page or in the Record form: the Recorder
   * opens the microphone only when it is `on`. Absent until they chose, which leaves it closed. */
  narration?: "on" | "off";
  /** The sites the person keeps out of every recording (sites.ts), sorted: nothing in a tab on one is recorded. */
  excludedSites?: string[];
};
export type PendingConnect = {
  origin: string;
  code: string;
  /** Only a page or OpenBot Desktop asks to connect; the launcher's connection is never pending. */
  via: "web" | "desktop";
  requestedAt: number;
  tabId?: number;
};
type SessionState = {
  recorder: RecorderState;
  pendingConnect?: PendingConnect;
  stream?: StreamSession; // so a restarted service worker can resume the offscreen document
  me?: { value: RecorderMe; fetchedAt: number };
  /** The person's own Learning space as OpenBot last described it to the popup, and the connection it was asked with:
   * Record copies it into the recording's state. Chrome stops a service worker idle for 30 s, so the one that answers
   * Record is often not the one the popup asked; it takes this up for the same connection only. */
  learning?: { value: LearningSpaceState; connectionId: string };
  /** Sensitive-value digests of the recording in progress. Memory only (storage.session is never written to disk
   * and is not readable by content scripts by default), so they survive a service-worker restart and vanish with
   * the browser; cleared at Stop. Never written to storage.local or IndexedDB. */
  digests?: string[];
  /** The digests of what the person typed into sensitive fields in each followed tab (by tab id), latest last: a save
   * from that tab whose body held one carries their values. Kept as `digests` are, and cleared with them. */
  typedSecrets?: [number, string[]][];
  /** openbot.connect requests per origin in the last 10 minutes (timestamps), for Decision 22's limit (Task 8). */
  connectRequests?: Record<string, number[]>;
  /** The last web connect the person cancelled on the Connect page, so the page that asked hears so
   * (`openbot.connect.status`); gone once that origin asks to connect again. */
  cancelledConnect?: { origin: string; at: number };
  /** The setup tab the install opened (setup.ts), so the launcher's connection can close it: a browser OpenBot opened
   * has its microphone granted already and is never shown a setup step. */
  setupTabId?: number;
};
const isString = (value: unknown): value is string => typeof value === "string";

function isKeptEvents(value: unknown): value is KeptEvents {
  if (typeof value !== "object" || value === null) return false;
  const kept = value as Record<string, unknown>;
  return (
    isString(kept.reason) &&
    typeof kept.parked === "boolean" &&
    typeof kept.events === "number" &&
    typeof kept.at === "number" &&
    (kept.waitingForReconnect === undefined ||
      typeof kept.waitingForReconnect === "boolean")
  );
}

/** A recording record in this build's shape. A build from before the Recorder sent to Intelligence only stored its
 * recordings by demonstration, which nothing can send any more. */
export function isDrainRecord(value: unknown): value is DrainRecord {
  if (typeof value !== "object" || value === null) return false;
  const drain = value as Record<string, unknown>;
  return (
    isString(drain.recordingId) &&
    isString(drain.title) &&
    isString(drain.openbotUrl) &&
    isString(drain.userId) &&
    isString(drain.userName) &&
    Array.isArray(drain.trajectoryIds) &&
    drain.trajectoryIds.every(isString) &&
    typeof drain.startedAt === "number" &&
    (drain.discarding === undefined || typeof drain.discarding === "boolean") &&
    (drain.kept === undefined || isKeptEvents(drain.kept)) &&
    (drain.held === undefined ||
      (Array.isArray(drain.held) && drain.held.every(isHeldEvent)))
  );
}

function isEvent(value: unknown): value is CapturedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    event.type === "CUSTOM" &&
    isString(event.name) &&
    typeof event.timestamp === "number"
  );
}

function isHeldEvent(value: unknown): value is HeldEvent {
  if (typeof value !== "object" || value === null) return false;
  const held = value as Record<string, unknown>;
  return isEvent(held.event) && (held.key === undefined || isString(held.key));
}

function isAgentSnapshot(value: unknown): value is AgentSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return Array.isArray(snapshot.tabs) && Array.isArray(snapshot.recordedRuns);
}

function isHeldSteps(value: unknown): value is HeldSteps {
  if (typeof value !== "object" || value === null) return false;
  const held = value as Record<string, unknown>;
  const steps = held.steps as Record<string, unknown> | null | undefined;
  return (
    isString(held.recordingId) &&
    typeof steps === "object" &&
    steps !== null &&
    Array.isArray(steps.queue) &&
    steps.queue.every(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        isEvent((step as Record<string, unknown>).event),
    ) &&
    Array.isArray(steps.calls) &&
    Array.isArray(steps.typed) &&
    (held.agent === undefined || isAgentSnapshot(held.agent))
  );
}

/** The recordings in storage.local are read through a shape check: one of another shape is left out (and goes with
 * the next write of the list), never handed to the code that sends recordings. */
function checked<K extends keyof LocalState>(
  key: K,
  value: unknown,
): LocalState[K] {
  if (value === undefined) return undefined as LocalState[K];
  if (key === "drains")
    return (
      Array.isArray(value) ? value.filter(isDrainRecord) : []
    ) as LocalState[K];
  if (key === "activeRecording")
    return (isDrainRecord(value) ? value : undefined) as LocalState[K];
  if (key === "heldSteps")
    return (isHeldSteps(value) ? value : undefined) as LocalState[K];
  if (key === "narration")
    return (
      value === "on" || value === "off" ? value : undefined
    ) as LocalState[K];
  if (key === "excludedSites") return normaliseSites(value) as LocalState[K];
  return value as LocalState[K];
}

export async function readLocal<K extends keyof LocalState>(
  key: K,
): Promise<LocalState[K]> {
  const items = await chrome.storage.local.get(key);
  return checked(key, items[key]);
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
/**
 * Keeps the bearer token out of content scripts: storage.local defaults to readable by them.
 *
 * Never rejects, as nothing the service worker starts at its top level may (recovery.ts says the same of recovery): it is
 * called there with nobody waiting on it, where a rejection was an unhandled one, said nowhere the Recorder's own
 * failures are. A failure is logged as theirs are, and the restriction is asked for again at the next start of the
 * service worker, which Chrome stops and starts many times a day.
 */
export async function restrictStorageToTrustedContexts(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch (error) {
    console.error(
      "Recorder: keeping its stored connection from content scripts failed; it asks again at its next start",
      error,
    );
  }
}
/** Reads `installSecret`, creating it with crypto.randomUUID() when absent. */
let pendingSecret: Promise<string> | null = null;
/** Concurrent callers share one in-flight read-or-create, so two first calls never mint two secrets;
 * the share clears on settle, so later calls read storage again and a failed write can retry. */
export function installSecret(): Promise<string> {
  pendingSecret ??= (async () => {
    const existing = await readLocal("installSecret");
    if (existing) return existing;
    const created = crypto.randomUUID();
    await writeLocal("installSecret", created);
    return created;
  })().finally(() => {
    pendingSecret = null;
  });
  return pendingSecret;
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
