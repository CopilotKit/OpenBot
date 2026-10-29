/*
 * The OpenBot Recorder's launcher API, standing in for the Recorder in agent-computer's tests while
 * the Recorder's own is built alongside it. It answers exactly as `LauncherApi` in
 * shared/openbot-browser.ts types it, and keeps what it holds in `chrome.storage.local` as the
 * Recorder does, so it survives its worker being stopped and started again.
 *
 * Like the Recorder, it attaches `chrome.debugger` to the tab it records for as long as it records:
 * that is what makes a browser show its "started debugging this browser" bar, which the live screen
 * must not lose the page to.
 *
 * What it was called with goes to the OpenBot it was connected to, at `/fixture/calls`, with what it
 * can see from inside the browser at that moment (its tabs, the one in front, its microphone
 * permission, whether it opened its setup page), so a test reads the Recorder's side of each call
 * rather than taking the computer's word for it.
 *
 * Like the Recorder, it asks OpenBot whether a connection stands before it takes it, and refuses one
 * OpenBot says is signed out.
 *
 * Like the Recorder, the last of a recording reaches Intelligence after Stop answers: for as long as the OpenBot it is
 * connected to says at `/fixture/tail` (none when it says nothing), `lastStopped.sending` is true. A disconnect in that
 * time keeps the rest for the person's next connection, as the Recorder does, so it is sending no longer; every report
 * says whether it was still sending when the call came.
 */
const LAUNCHER_GLOBAL = "openbotLauncher";
/**
 * Which build of this script is running, sent with every call. A test copies the fixture, changes this
 * line, and reads back which build answered, as a person's browser would run a Recorder rebuilt since.
 */
const BUILD = "fixture";

async function held() {
  const stored = await chrome.storage.local.get([
    "connection",
    "narration",
    "recording",
    "lastStopped",
    "setupOpened",
    "sendingUntil",
  ]);
  return {
    connection: stored.connection,
    narration: stored.narration ?? "own",
    recording: stored.recording,
    lastStopped: stored.lastStopped,
    setupOpened: stored.setupOpened === true,
    sendingUntil: stored.sendingUntil ?? 0,
  };
}

/** Whether the last of the recording Stop ended is still on its way to Intelligence. */
const sending = (now) =>
  Boolean(now.lastStopped) && Date.now() < now.sendingUntil;

/** How long the OpenBot this is connected to says the last of a stopped recording takes to send. */
async function tailMs(connection) {
  const answer = await fetch(new URL("/fixture/tail", connection.openbotUrl))
    .then((response) => response.json())
    .catch(() => ({}));
  return typeof answer.ms === "number" ? answer.ms : 0;
}

function stateOf(now) {
  const { tabId: _recorded, ...recording } = now.recording ?? {};
  return {
    connected: Boolean(now.connection),
    ...(now.connection
      ? {
          userId: now.connection.user.id,
          connectionId: now.connection.connectionId,
        }
      : {}),
    phase: now.recording ? "recording" : "idle",
    ...recording,
    actions: 0,
    narration: now.narration,
    // Hearing the person itself only for `own`: while it records, and not at all otherwise.
    ...(now.narration === "own"
      ? { voice: now.recording ? "listening" : "off" }
      : {}),
    ...(now.lastStopped
      ? {
          lastStopped: sending(now)
            ? { ...now.lastStopped, sending: true }
            : now.lastStopped,
        }
      : {}),
  };
}

/**
 * The tab the person is on, as the Recorder finds it: in the window they used last, or, in a browser
 * on a screen that never had a window in focus, any window's.
 */
async function frontTab() {
  const [focused] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focused) return focused;
  const [shown] = await chrome.tabs.query({ active: true });
  return shown;
}

async function report(method, input) {
  const now = await held();
  if (!now.connection) return;
  const tabs = await chrome.tabs.query({});
  const [front] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const microphone = (await navigator.permissions.query({ name: "microphone" }))
    .state;
  await fetch(new URL("/fixture/calls", now.connection.openbotUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method,
      input,
      tabs: tabs.map((tab) => tab.url ?? tab.pendingUrl ?? ""),
      front: front?.url ?? "",
      microphone,
      setupOpened: now.setupOpened,
      sending: sending(now),
      build: BUILD,
    }),
  });
}

/**
 * Whether OpenBot says this connection is signed out, which the Recorder asks before it takes one
 * (`confirm` in extension/src/background/launcher.ts). Only that answer refuses it: an OpenBot that
 * cannot be reached leaves the connection taken, as the Recorder's does.
 */
async function signedOut(connection) {
  const me = await fetch(new URL("/api/recorder/me", connection.openbotUrl), {
    headers: { authorization: `Bearer ${connection.token}` },
  }).catch(() => undefined);
  return me?.status === 401;
}

globalThis[LAUNCHER_GLOBAL] = {
  async connect(input) {
    // The connection it holds already, handed again, is taken at once: the Recorder asks only of a new one.
    const now = await held();
    const holding =
      JSON.stringify(now.connection) === JSON.stringify(input.connection) &&
      now.narration === input.narration;
    if (!holding && (await signedOut(input.connection))) {
      // As the Recorder ends after OpenBot says its connection is gone: signed out, and a recording
      // under it stopped.
      if (now.recording)
        await chrome.debugger
          .detach({ tabId: now.recording.tabId })
          .catch(() => undefined);
      await chrome.storage.local.set({ connection: null, recording: null });
      return {
        ok: false,
        error:
          "OpenBot did not accept this browser's connection. Open the browser from OpenBot again.",
      };
    }
    await chrome.storage.local.set({
      connection: input.connection,
      narration: input.narration,
    });
    await report("connect", input);
    return { ok: true };
  },
  async record(input) {
    const now = await held();
    if (!now.connection) return { ok: false, error: "Not connected." };
    if (input.action === "start") {
      if (now.recording) return { ok: false, error: "Already recording." };
      const front = await frontTab();
      if (front?.id === undefined)
        return { ok: false, error: "There is no tab to record." };
      await chrome.debugger.attach({ tabId: front.id }, "1.3");
      now.recording = {
        recordingId: crypto.randomUUID(),
        title: input.title,
        startedAt: Date.now(),
        tabId: front.id,
      };
    } else {
      if (!now.recording)
        return { ok: false, error: "Nothing is being recorded." };
      await chrome.debugger
        .detach({ tabId: now.recording.tabId })
        .catch(() => undefined);
      now.lastStopped = {
        recordingId: now.recording.recordingId,
        title: now.recording.title,
        stoppedAt: Date.now(),
      };
      now.recording = undefined;
      now.sendingUntil = Date.now() + (await tailMs(now.connection));
    }
    await chrome.storage.local.set({
      recording: now.recording ?? null,
      lastStopped: now.lastStopped ?? null,
      sendingUntil: now.sendingUntil,
    });
    await report("record", input);
    return { ok: true, state: stateOf(now) };
  },
  async narrate(input) {
    const now = await held();
    if (!now.recording)
      return { ok: false, error: "Nothing is being recorded." };
    await report("narrate", input);
    return { ok: true };
  },
  async speaking(input) {
    const now = await held();
    if (!now.recording)
      return { ok: false, error: "Nothing is being recorded." };
    await report("speaking", input);
    return { ok: true };
  },
  async disconnect() {
    const now = await held();
    // Said while it still knows where to say it, then forgotten. A recording ends as a sign-out ends
    // one: stopped, with nothing kept as the last one Stop ended.
    await report("disconnect", undefined);
    if (now.recording)
      await chrome.debugger
        .detach({ tabId: now.recording.tabId })
        .catch(() => undefined);
    // What had not gone is kept for the person's next connection: nothing is on its way any more.
    await chrome.storage.local.set({
      connection: null,
      recording: null,
      sendingUntil: 0,
    });
    return { ok: true };
  },
  async state() {
    return stateOf(await held());
  },
};

// As the Recorder does on install: open its setup page. A browser OpenBot opened must never show it.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ setupOpened: true });
  await chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
});
