/*
 * The OpenBot Recorder's launcher API, standing in for the Recorder in agent-computer's tests while
 * the Recorder's own is built alongside it. It answers exactly as `LauncherApi` in
 * shared/openbot-browser.ts types it, and keeps what it holds in `chrome.storage.local` as the
 * Recorder does, so it survives its worker being stopped and started again.
 *
 * What it was called with goes to the OpenBot it was connected to, at `/fixture/calls`, with what it
 * can see from inside the browser at that moment (its tabs, the one in front, its microphone
 * permission, whether it opened its setup page), so a test reads the Recorder's side of each call
 * rather than taking the computer's word for it.
 */
const LAUNCHER_GLOBAL = "openbotLauncher";

async function held() {
  const stored = await chrome.storage.local.get([
    "connection",
    "narration",
    "recording",
    "setupOpened",
  ]);
  return {
    connection: stored.connection,
    narration: stored.narration ?? "own",
    recording: stored.recording,
    setupOpened: stored.setupOpened === true,
  };
}

function stateOf(now) {
  return {
    connected: Boolean(now.connection),
    ...(now.connection ? { userId: now.connection.user.id } : {}),
    phase: now.recording ? "recording" : "idle",
    ...(now.recording ?? {}),
    actions: 0,
    narration: now.narration,
  };
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
    }),
  });
}

globalThis[LAUNCHER_GLOBAL] = {
  async connect(input) {
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
      now.recording = {
        recordingId: crypto.randomUUID(),
        title: input.title,
        startedAt: Date.now(),
      };
    } else {
      if (!now.recording)
        return { ok: false, error: "Nothing is being recorded." };
      now.recording = undefined;
    }
    await chrome.storage.local.set({ recording: now.recording ?? null });
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
  async state() {
    return stateOf(await held());
  },
};

// As the Recorder does on install: open its setup page. A browser OpenBot opened must never show it.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ setupOpened: true });
  await chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
});
