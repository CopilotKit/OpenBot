// The security floor in the Recorder (shared/security-floor.ts): the lowest safe Recorder, which CopilotKit raises only
// when a release has a security problem. Below it, while the Recorder is connected to an OpenBot the floor holds for,
// no recording starts or goes on, nothing of a recording is sent, and every Recorder page shows one notice with Update
// and restart. Nothing is deleted: what was recorded waits in this browser and goes once the Recorder is updated.
//
// The floor holds for OpenBot Desktop's own OpenBot on this computer (the address its native host confirms,
// native-host.ts `desktopAddress`) and for the OpenBot Cloud addresses the floor lists. A company's own OpenBot never
// appears in that list, so a Recorder connected to one ignores the floor. Not connected: there is nothing to hold.
//
// The floor is read at every browser start, at install and update, and every six hours (an alarm, as the keep-alive's
// in connection.ts). Offline, the floor verified last still holds; a Recorder that never reached the feed runs.
import {
  belowFloor,
  type FloorStore,
  floorApplies,
  heldSecurityFloor,
  refreshSecurityFloor,
  SECURITY_FLOOR_SENTENCE,
  type SecurityFloor,
} from "@openbot/shared/security-floor";
import type { PageResponse, PageToBackground } from "../protocol/messages";
import { normaliseOpenBotOrigin } from "../shared/origin";
import { SECURITY_FLOOR_ADDRESSES } from "../shared/security-floor-addresses";
import { readLocal, writeLocal } from "../shared/storage";
import { type ConnectionLoss, currentConnection } from "./connection";
import { desktopAddress } from "./native-host";

export const SECURITY_FLOOR_ALARM = "recorder-security-floor";
const PERIOD_MINUTES = 6 * 60;
const PERIOD_MS = PERIOD_MINUTES * 60 * 1000;
/** How long Update and restart waits for Chrome to download an update it found before it restarts anyway. */
const UPDATE_WAIT_MS = 60_000;

/** The page messages refused while the floor holds: each starts a recording or asks OpenBot for something. */
const REFUSED = new Set<PageToBackground["type"]>([
  "page.record",
  "page.restart",
  "page.learning",
  "page.voice",
]);

/** What the floor drives: the recording controller (recording.ts). */
export type FloorControls = {
  page(
    message: PageToBackground,
    sender: chrome.runtime.MessageSender,
  ): Promise<PageResponse>;
  connected(): Promise<void>;
  connectionLost(loss: ConnectionLoss): Promise<void>;
};

export type FloorDeps = {
  /** The keys a floor must be signed with; the ones built into the Recorder unless a test passes its own. */
  keys?: readonly string[];
  /** Where the floor is read; the Recorder's own (shared/security-floor-addresses.ts) by default. */
  addresses?: readonly string[];
  /** How the feed is read: the browser's own request unless a test passes its feed (shared/security-floor.ts). */
  read?: Parameters<typeof refreshSecurityFloor>[0]["fetch"];
  desktopAddress: () => Promise<string | null>;
  /** This copy's release: the manifest's full version name, else its Chrome version. */
  version: () => string;
  now: () => number;
};

const defaultDeps: FloorDeps = {
  desktopAddress: () => desktopAddress(),
  version: () => {
    const manifest = chrome.runtime.getManifest();
    return manifest.version_name ?? manifest.version;
  },
  now: () => Date.now(),
};

/** The floor this copy verified last, in storage.local, as it was published: verified again each time it is read. */
export const floorStore: FloorStore = {
  read: async () => (await readLocal("securityFloor")) ?? null,
  write: (text) => writeLocal("securityFloor", text),
};

/** The release to update to while the floor holds this copy, else null. */
export type FloorHold = { release: string } | null;

export type SecurityFloorGuard<C> = {
  /** The recording controller, refusing what the floor forbids while it holds. */
  recording: C;
  /** Runs `work` once the floor this copy holds is known, unless it holds: recovery sends kept recordings. */
  whenAllowed(work: () => Promise<void>): Promise<void>;
  /** Reads the floor from its feed now, and acts on it. Never rejects: a failure is logged. */
  refresh(): Promise<void>;
  /** Whether the floor holds this copy now, once the floor it holds is known. */
  hold(): Promise<FloorHold>;
};

export function installSecurityFloor<C extends FloorControls>(
  controller: C,
  overrides: Partial<FloorDeps> = {},
): SecurityFloorGuard<C> {
  const deps: FloorDeps = { ...defaultDeps, ...overrides };
  const options = { store: floorStore, keys: deps.keys };
  let hold: FloorHold = null;

  /** Deciding and acting run one at a time, so two checks never both stop the recording. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Whether `origin` is OpenBot Desktop's own OpenBot on this computer: only plain http on a loopback address can be,
   * and only the address its native host confirms is. */
  async function isDesktops(origin: string): Promise<boolean> {
    if (new URL(origin).protocol !== "http:") return false;
    const confirmed = normaliseOpenBotOrigin(
      (await deps.desktopAddress()) ?? "",
    );
    return confirmed.ok && confirmed.origin === origin;
  }

  async function decide(floor: SecurityFloor | null): Promise<FloorHold> {
    const release = belowFloor(floor, "recorder", deps.version());
    if (!floor || !release) return null;
    const connection = await currentConnection();
    if (!connection) return null;
    const applies =
      floorApplies(floor, { origin: connection.openbotUrl }) ||
      ((await isDesktops(connection.openbotUrl)) &&
        floorApplies(floor, { contained: true }));
    return applies ? { release } : null;
  }

  /** Holds this copy, or lets it go. Once it holds, the live recording stops the way a policy move stops it: its
   * streams halted, a failed outcome queued, and everything kept for its person in this browser, sent once the Recorder
   * is updated (recovery sends a connected person's kept recordings at every start the floor allows). */
  function act(floor: SecurityFloor | null): Promise<void> {
    return serially(async () => {
      const next = await decide(floor);
      const was = hold;
      hold = next;
      if (!next || was) return;
      const connection = await currentConnection();
      if (connection)
        await controller.connectionLost({ kind: "policy", connection });
    });
  }

  const report = (what: string) => (error: unknown) =>
    console.error(`Recorder: ${what} failed`, error);

  const reconsider = () =>
    heldSecurityFloor(options).then(act).catch(report("checking the floor"));

  async function refresh(): Promise<void> {
    const floor = await refreshSecurityFloor({
      ...options,
      ...(deps.read ? { fetch: deps.read } : {}),
      addresses: deps.addresses ?? SECURITY_FLOOR_ADDRESSES,
    });
    await writeLocal("securityFloorCheckedAt", deps.now());
    await act(floor);
  }

  /** The alarm can be cleared by a browser restart or an update, so every start makes sure it exists, and reads the
   * feed when the last read is older than the period. */
  async function schedule(): Promise<void> {
    if (!(await chrome.alarms.get(SECURITY_FLOOR_ALARM)))
      await chrome.alarms.create(SECURITY_FLOOR_ALARM, {
        periodInMinutes: PERIOD_MINUTES,
      });
    const last = await readLocal("securityFloorCheckedAt");
    if (last === undefined || deps.now() - last > PERIOD_MS) await refresh();
  }

  let updating = false;
  let waitingForUpdate: ReturnType<typeof setTimeout> | undefined;
  /** Update and restart: Chrome checks for an update now, and the Recorder restarts on what it finds. An update Chrome
   * found restarts it once downloaded (onUpdateAvailable), or after UPDATE_WAIT_MS at the latest. No update, or a check
   * Chrome throttled, restarts it at once: the restart checks the floor again. */
  async function updateAndRestart(): Promise<void> {
    updating = true;
    let status = "failed";
    try {
      status = (await chrome.runtime.requestUpdateCheck()).status;
    } catch (error) {
      report("checking for an update")(error);
    }
    if (status !== "update_available") {
      chrome.runtime.reload();
      return;
    }
    clearTimeout(waitingForUpdate);
    waitingForUpdate = setTimeout(
      () => chrome.runtime.reload(),
      UPDATE_WAIT_MS,
    );
  }

  // Registered synchronously, as every listener of the service worker is (index.ts).
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SECURITY_FLOOR_ALARM)
      void refresh().catch(report("reading the floor"));
  });
  // A browser start reads it too: index.ts's one onStartup listener calls `refresh`.
  chrome.runtime.onInstalled.addListener(() => {
    void refresh().catch(report("reading the floor"));
  });
  // Below the floor, an update Chrome has ready is installed at once.
  chrome.runtime.onUpdateAvailable.addListener(() => {
    if (!hold && !updating) return;
    clearTimeout(waitingForUpdate);
    chrome.runtime.reload();
  });
  // A connection made or changed by any path (a Connect, OpenBot Desktop, the launcher, a policy) is weighed again.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "connection" in changes) void reconsider();
  });

  const known = reconsider();
  void known.then(() => schedule()).catch(report("scheduling the floor"));

  const recording: C = {
    ...controller,
    async page(message, sender) {
      if (message.type === "page.floor") {
        await known;
        await queue;
        return { ok: true, floor: hold };
      }
      if (message.type === "page.update") {
        await updateAndRestart();
        return { ok: true };
      }
      await known;
      if (hold && REFUSED.has(message.type))
        return { ok: false, error: SECURITY_FLOOR_SENTENCE };
      return controller.page(message, sender);
    },
    async connected() {
      await known;
      // The connection that was just made is weighed first: kept recordings wait for the Recorder's update.
      await reconsider();
      if (hold) return;
      await controller.connected();
    },
  };

  return {
    recording,
    async whenAllowed(work) {
      await known;
      if (!hold) await work();
    },
    refresh: () => refresh().catch(report("reading the floor")),
    async hold() {
      await known;
      await queue;
      return hold;
    },
  };
}
