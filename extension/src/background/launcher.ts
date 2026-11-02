// The Recorder's launcher API: what the process that launched this browser, and alone holds its DevTools pipe, calls in
// this service worker as `globalThis[LAUNCHER_GLOBAL]` (shared/openbot-browser.ts). OpenBot opens a person's own
// browser with the Recorder in it, and hands it its connection and its Record, Stop and narration through here.
//
// Reachable only by code running in this service worker itself: the launcher evaluates it over the DevTools protocol
// (Runtime.evaluate in the worker's target). There is no chrome.runtime message route to it, internal or external, so
// no web page, content script or other extension can reach it, and none of the Recorder's own pages does either: each
// of them is its own global scope. A connection taken here is checked as a Connect would check it (the OpenBot address
// rule and the organization's policy), and every command goes through the same paths the popup's own do. A revoke
// OpenBot tells it of goes through the path a signed-out answer from OpenBot takes.
import {
  LAUNCHER_GLOBAL,
  type LauncherApi,
  type LauncherConnection,
  type LauncherResult,
  type LauncherState,
  type Narration,
} from "@openbot/shared/openbot-browser";
import {
  joinedLearningContainer,
  type RecorderMe,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import type { PageResponse, RecorderState } from "../protocol/messages";
import { OpenBotError, openbotJson } from "../shared/openbot-client";
import { normaliseOpenBotOrigin } from "../shared/origin";
import { allowsOpenBot, readPolicy } from "../shared/policy";
import { narrationLanguage } from "../shared/speech-language";
import {
  type ConnectionRecord,
  readLocal,
  writeLocal,
  writeSession,
} from "../shared/storage";
import { showBadge } from "./badge";
import {
  type ConnectionLoss,
  connectFromLauncher,
  currentConnection,
} from "./connection";
import type { LauncherSide } from "./recording";
import type { RouterHandlers } from "./router";

/** What the launcher drives: the recording controller the popup drives (recording.ts). */
export type LauncherControls = Pick<RouterHandlers, "page"> &
  LauncherSide & {
    connected(): Promise<void>;
    connectionLost(loss: ConnectionLoss): Promise<void>;
  };

type LauncherDeps = {
  readPolicy: typeof readPolicy;
  /** The tab the person is on: the active tab of the window they used last. */
  activeTab: () => Promise<chrome.tabs.Tab | undefined>;
  /** The page's own language, read as the popup reads it when Record is pressed. */
  pageLanguage: (tabId: number) => Promise<string | null>;
  now: () => number;
};

/** How long a connection waits on OpenBot to say who it is for: it is stored either way, and the keep-alive asks again. */
const ME_WAIT_MS = 5_000;
const TITLE_MAX = 200;
const PHRASE_MAX = 4_000;

const SENTENCES = {
  invalid: "The Recorder could not read that request.",
  address:
    "That OpenBot address is not one the Recorder connects to. It must be https, or http on 127.0.0.1 or [::1] with a port.",
  policyInvalid:
    "Your organization's Recorder policy names an OpenBot address the Recorder cannot use. Ask your IT team.",
  pinnedElsewhere:
    "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.",
  refused:
    "OpenBot did not accept this browser's connection. Open the browser from OpenBot again.",
  notConnected: "Connect this browser to OpenBot first.",
  noTab: "There is no tab to record. Open one and try again.",
  failed: "The Recorder could not do that. Try again.",
} as const;

const refuse = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max;
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The launcher's connection, read as the contract types it: anything else is refused, whatever sent it. */
function connectionFrom(value: unknown): LauncherConnection | null {
  if (!isRecord(value)) return null;
  const { openbotUrl, token, connectionId, user } = value;
  if (
    !isText(openbotUrl, 2000) ||
    !isText(token, 200) ||
    !token.startsWith("obr_") ||
    !isText(connectionId, 200) ||
    !isRecord(user) ||
    !isText(user.id, 200) ||
    typeof user.name !== "string" ||
    typeof user.email !== "string"
  )
    return null;
  return {
    openbotUrl,
    token,
    connectionId,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

const NARRATIONS: readonly Narration[] = ["own", "external"];

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [focused] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focused) return focused;
  // A browser on a screen may never have had a window in focus: any window's active tab is the one on show.
  const [shown] = await chrome.tabs.query({ active: true });
  return shown;
}

async function pageLanguage(tabId: number): Promise<string | null> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.lang,
    });
    return typeof frame?.result === "string" && frame.result
      ? frame.result
      : null;
  } catch {
    return null;
  }
}

const defaultDeps: LauncherDeps = {
  readPolicy,
  activeTab,
  pageLanguage,
  now: () => Date.now(),
};

/** The same connection, as far as anything the Recorder keeps is concerned: connecting it again changes nothing. */
function sameConnection(
  stored: ConnectionRecord | null,
  next: ConnectionRecord,
): boolean {
  return (
    stored !== null &&
    stored.via === next.via &&
    stored.openbotUrl === next.openbotUrl &&
    stored.token === next.token &&
    stored.connectionId === next.connectionId &&
    stored.user.id === next.user.id &&
    stored.user.name === next.user.name &&
    stored.user.email === next.user.email &&
    (stored.narration ?? "own") === (next.narration ?? "own")
  );
}

/**
 * Whether the Recorder hears the person itself, from its own recogniser's report (the popup's Voice row): listening
 * while the microphone is open or opening, muted as the person set it, unavailable when it failed (no permission, no
 * microphone, no speech service, or one it cannot reach just now and tries again), and off while nothing is recorded
 * (a Record still starting has opened no microphone yet). The contract has no word for a microphone still opening; it
 * is reported as listening, as the popup's Voice row shows it on.
 */
function voiceOf(state: RecorderState): NonNullable<LauncherState["voice"]> {
  if (state.phase === "idle") return "off";
  switch (state.capture.voice?.state) {
    case "starting":
    case "listening":
      return "listening";
    case "muted":
      return "muted";
    case "failed":
      return "unavailable";
    case undefined:
      return "off";
  }
}

/** The recording Stop ended last, by name and with what it held, once it went to Intelligence (a Disconnect or a
 * failed send leaves none), and not when the person's own Learning space is known not to take it: OpenBot confirms it
 * went there, or says it held nothing. One stopped by an earlier build, which did not count, is not reported: OpenBot
 * would say it held nothing. OpenBot's own page reads it the same way (openbot-page.ts). */
export function lastStopped(
  state: RecorderState,
): LauncherState["lastStopped"] {
  const stopped = state.lastStopped;
  if (
    stopped?.title === undefined ||
    stopped.stoppedAt === undefined ||
    stopped.actions === undefined ||
    stopped.phrases === undefined
  )
    return undefined;
  if (state.learning && joinedLearningContainer(state.learning) === null)
    return undefined;
  return {
    recordingId: stopped.recordingId,
    title: stopped.title,
    stoppedAt: stopped.stoppedAt,
    actions: stopped.actions,
    phrases: stopped.phrases,
  };
}

/**
 * Whether some of a stopped recording is still on its way to Intelligence: its drain is still in storage (it goes on
 * offscreen.done, once all of it is sent), and it is neither kept for later (a hold or park row, or waiting for its
 * person to connect again) nor being discarded.
 */
async function stillSending(recordingId: string): Promise<boolean> {
  const drains = (await readLocal("drains")) ?? [];
  return drains.some(
    (drain) =>
      drain.recordingId === recordingId &&
      !drain.discarding &&
      drain.kept === undefined,
  );
}

export function createLauncher(
  controls: LauncherControls,
  overrides: Partial<LauncherDeps> = {},
): LauncherApi {
  const deps: LauncherDeps = { ...defaultDeps, ...overrides };

  async function launcherState(): Promise<LauncherState> {
    const connection = await currentConnection();
    const state: RecorderState = await controls.current();
    const narration = connection?.narration ?? "own";
    const stopped = lastStopped(state);
    const sending =
      stopped !== undefined && (await stillSending(stopped.recordingId));
    return {
      connected: connection !== null,
      ...(connection
        ? { userId: connection.user.id, connectionId: connection.connectionId }
        : {}),
      phase: state.phase,
      ...(state.recordingId ? { recordingId: state.recordingId } : {}),
      ...(state.title ? { title: state.title } : {}),
      ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
      actions: state.actions,
      narration,
      ...(narration === "own" ? { voice: voiceOf(state) } : {}),
      ...(stopped
        ? { lastStopped: sending ? { ...stopped, sending } : stopped }
        : {}),
    };
  }

  /** Who OpenBot says a connection is for, as the popup would ask when it opens, asked BEFORE the connection is taken:
   * `signed-out` when OpenBot revoked it already, `unknown` when OpenBot cannot answer for now (the connection is taken,
   * and the keep-alive asks again). */
  async function ask(connection: ConnectionRecord): Promise<
    | { kind: "ok"; value: RecorderMe }
    | {
        kind: "signed-out";
        reason: Extract<ConnectionLoss, { kind: "signed-out" }>["reason"];
      }
    | { kind: "unknown" }
  > {
    try {
      const value = await openbotJson<RecorderMe>(
        connection,
        recorderPaths.me,
        {
          signal: AbortSignal.timeout(ME_WAIT_MS),
        },
      );
      return { kind: "ok", value };
    } catch (error) {
      if (error instanceof OpenBotError && error.signedOut)
        return { kind: "signed-out", reason: error.body?.reason ?? "revoked" };
      return { kind: "unknown" };
    }
  }

  /** Every method resolves, and a refusal is `{ ok: false }`: whatever goes wrong inside is said as a sentence, never
   * thrown back down the DevTools pipe. */
  function guarded<A extends unknown[], R>(
    work: (...args: A) => Promise<R>,
    failed: () => R | Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      try {
        return await work(...args);
      } catch (error) {
        console.error("Recorder: the launcher's request failed", error);
        return failed();
      }
    };
  }

  const answer = async (
    response: PageResponse,
  ): Promise<LauncherResult<{ state: LauncherState }>> =>
    response.ok
      ? { ok: true, state: await launcherState() }
      : refuse(response.error);

  return {
    connect: guarded(
      async (input: unknown): Promise<LauncherResult> => {
        if (!isRecord(input)) return refuse(SENTENCES.invalid);
        const connection = connectionFrom(input.connection);
        const narration = input.narration;
        if (!connection || !NARRATIONS.includes(narration as Narration))
          return refuse(SENTENCES.invalid);
        const checked = normaliseOpenBotOrigin(connection.openbotUrl);
        if (!checked.ok) return refuse(SENTENCES.address);
        const policy = await deps.readPolicy();
        if (policy.openbotUrlInvalid) return refuse(SENTENCES.policyInvalid);
        if (!allowsOpenBot(policy, checked.origin))
          return refuse(SENTENCES.pinnedElsewhere);
        const record: ConnectionRecord = {
          openbotUrl: checked.origin,
          token: connection.token,
          connectionId: connection.connectionId,
          user: connection.user,
          via: "openbot-browser",
          connectedAt: deps.now(),
          narration: narration as Narration,
        };
        const current = await currentConnection();
        if (sameConnection(current, record)) return { ok: true };
        /*
         * Asked before it is taken. Two opens of one browser can cross, and the older one's connection, revoked by the
         * newer one's, can arrive last: taking it first would sign out the connection that stands and stop its
         * recording. A revoked connection is refused and the one held stays; with none held (or this one), it ends as
         * OpenBot's own signed-out answer does, with the notice.
         */
        const asked = await ask(record);
        if (asked.kind === "signed-out") {
          if (current && current.token !== record.token)
            return refuse(SENTENCES.refused);
          // Taken and lost at once, so the popup says why this browser is not connected.
          await connectFromLauncher(record, { readPolicy: deps.readPolicy });
          await controls.connectionLost({
            kind: "signed-out",
            reason: asked.reason,
            connection: record,
          });
          return refuse(SENTENCES.refused);
        }
        if (
          !(await connectFromLauncher(record, { readPolicy: deps.readPolicy }))
        )
          return refuse(SENTENCES.pinnedElsewhere);
        if (asked.kind === "ok") {
          await writeSession("me", {
            value: asked.value,
            fetchedAt: deps.now(),
          });
          await writeLocal("lastKeepAliveAt", deps.now());
        }
        // What an approved Connect does next: a recording of this person goes on under the new token, and their kept
        // recordings are sent.
        await controls.connected();
        await showBadge(await controls.current());
        return { ok: true };
      },
      () => refuse(SENTENCES.failed),
    ),

    record: guarded(
      async (
        input: unknown,
      ): Promise<LauncherResult<{ state: LauncherState }>> => {
        if (!isRecord(input)) return refuse(SENTENCES.invalid);
        if (input.action === "stop")
          return answer(await controls.page({ type: "page.stop" }, {}));
        if (input.action !== "start" || !isText(input.title, TITLE_MAX))
          return refuse(SENTENCES.invalid);
        if (
          input.tabId !== undefined &&
          !(typeof input.tabId === "number" && Number.isInteger(input.tabId))
        )
          return refuse(SENTENCES.invalid);
        if (input.narrate !== undefined && typeof input.narrate !== "boolean")
          return refuse(SENTENCES.invalid);
        if (!(await currentConnection())) return refuse(SENTENCES.notConnected);
        const tabId =
          typeof input.tabId === "number"
            ? input.tabId
            : (await deps.activeTab())?.id;
        if (tabId === undefined) return refuse(SENTENCES.noTab);
        // The person's own language when the launcher hears them, else the page's, as the popup reads it.
        const language =
          typeof input.language === "string" && input.language.trim()
            ? input.language
            : narrationLanguage(
                await deps.pageLanguage(tabId),
                navigator.language,
              );
        return answer(
          await controls.page(
            {
              type: "page.record",
              title: input.title.trim(),
              tabId,
              language,
              // Whether the person narrates, as OpenBot's own Record form asked them.
              ...(typeof input.narrate === "boolean"
                ? { narrate: input.narrate }
                : {}),
            },
            {},
          ),
        );
      },
      () => refuse(SENTENCES.failed),
    ),

    narrate: guarded(
      async (input: unknown): Promise<LauncherResult> => {
        if (
          !isRecord(input) ||
          !isText(input.text, PHRASE_MAX) ||
          !isTime(input.startedAt) ||
          !isTime(input.endedAt) ||
          input.endedAt < input.startedAt
        )
          return refuse(SENTENCES.invalid);
        const response = await controls.narrate({
          text: input.text,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
        });
        return response.ok ? { ok: true } : refuse(response.error);
      },
      () => refuse(SENTENCES.failed),
    ),

    speaking: guarded(
      async (input: unknown): Promise<LauncherResult> => {
        if (!isRecord(input) || !(input.since === null || isTime(input.since)))
          return refuse(SENTENCES.invalid);
        const response = await controls.speaking(input.since);
        return response.ok ? { ok: true } : refuse(response.error);
      },
      () => refuse(SENTENCES.failed),
    ),

    // OpenBot revoked this browser's connection (the person disconnected it in Settings, Browsers) and says so now,
    // rather than leaving the Recorder to hear it on its next call to OpenBot, which on a quiet browser is the keep-alive,
    // hours away. It goes the way OpenBot answering that the token is gone goes: the connection is forgotten with the
    // signed-out notice, a recording under it stops as signed out and is kept for its person, and the next connection
    // the launcher hands in sends it. OpenBot has revoked the token already, so it is not asked to again.
    disconnect: guarded(
      async (): Promise<LauncherResult> => {
        const connection = await currentConnection();
        if (connection)
          await controls.connectionLost({
            kind: "signed-out",
            reason: "revoked",
            connection,
          });
        return { ok: true };
      },
      () => refuse(SENTENCES.failed),
    ),

    state: guarded(launcherState, async () => ({
      connected: false,
      phase: "idle",
      actions: 0,
      narration: "own",
    })),
  };
}

/** Puts the launcher API where its launcher reaches it: this service worker's own global scope, and nowhere else. */
export function installLauncher(
  controls: LauncherControls,
  overrides?: Partial<LauncherDeps>,
): LauncherApi {
  const api = createLauncher(controls, overrides);
  Object.defineProperty(globalThis, LAUNCHER_GLOBAL, {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return api;
}
