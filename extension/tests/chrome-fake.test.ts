import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

test("a port opened with connectFrom delivers to onConnect listeners and carries messages both ways", () => {
  const received: unknown[] = [];
  let swPort: chrome.runtime.Port | undefined;
  chrome.runtime.onConnect.addListener((port) => {
    swPort = port;
    port.onMessage.addListener((message) => received.push(message));
  });
  const far = fake.connectFrom("recorder:offscreen", {
    id: "x",
    url: "chrome-extension://x/offscreen.html",
  });
  expect(swPort?.name).toBe("recorder:offscreen");
  expect(swPort?.sender?.url).toBe("chrome-extension://x/offscreen.html");
  far.postMessage({ type: "offscreen.ready" });
  swPort?.postMessage({ type: "offscreen.start" });
  expect(received).toEqual([{ type: "offscreen.ready" }]);
  expect(far.messages).toEqual([{ type: "offscreen.start" }]);
  expect(fake.calls).toContain("port:recorder:offscreen offscreen.ready");
  expect(fake.calls).toContain("port:recorder:offscreen offscreen.start");
  swPort?.disconnect();
  expect(far.onDisconnect.called).toBe(true);
});

test("storage get and set round-trip, copy their values and notify onChanged", async () => {
  const changes: unknown[] = [];
  chrome.storage.onChanged.addListener((change, area) =>
    changes.push([change, area]),
  );
  const value = { nested: [1] };
  await chrome.storage.local.set({ a: value, b: 2 });
  value.nested.push(2);
  expect(await chrome.storage.local.get<Record<string, unknown>>("a")).toEqual({
    a: { nested: [1] },
  });
  expect(
    await chrome.storage.local.get<Record<string, unknown>>(["b", "missing"]),
  ).toEqual({ b: 2 });
  expect(
    await chrome.storage.local.get<Record<string, unknown>>({ b: 0, c: 3 }),
  ).toEqual({ b: 2, c: 3 });
  expect(await chrome.storage.local.get<Record<string, unknown>>(null)).toEqual(
    { a: { nested: [1] }, b: 2 },
  );
  await chrome.storage.local.remove("b");
  expect(fake.storage.local.has("b")).toBe(false);
  expect(changes.length).toBe(2);
  fake.storage.setManaged({ openbotOrigin: "https://openbot.example.test" });
  expect(
    await chrome.storage.managed.get<Record<string, unknown>>("openbotOrigin"),
  ).toEqual({ openbotOrigin: "https://openbot.example.test" });
});

test("setManaged fires storage.onChanged and storage.managed.onChanged with the managed area name", () => {
  fake.storage.setManaged({ keep: "a", drop: "b", change: 1 });
  const global: unknown[] = [];
  const area: unknown[] = [];
  chrome.storage.onChanged.addListener((changes, areaName) =>
    global.push([changes, areaName]),
  );
  chrome.storage.managed.onChanged.addListener((changes) => area.push(changes));
  fake.storage.setManaged({ keep: "a", change: 2, added: true });
  const expected = {
    change: { oldValue: 1, newValue: 2 },
    added: { newValue: true },
    drop: { oldValue: "b" },
  };
  expect(global).toEqual([[expected, "managed"]]);
  expect(area).toEqual([expected]);
  fake.storage.setManaged({ keep: "a", change: 2, added: true });
  expect(global.length).toBe(1);
});

test("setAccessLevel is recorded for local and session", async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  });
  expect(fake.storage.accessLevel).toBe("TRUSTED_CONTEXTS");
  expect(fake.storage.sessionAccessLevel).toBe(
    "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  );
});

test("permissions.contains answers from granted and request grants when the answer is yes", async () => {
  expect(
    await chrome.permissions.contains({
      origins: ["https://a.example.test/*"],
    }),
  ).toBe(false);
  fake.permissions.granted.add("https://a.example.test/*");
  expect(
    await chrome.permissions.contains({
      origins: ["https://a.example.test/*"],
    }),
  ).toBe(true);
  expect(await chrome.permissions.request({ origins: ["<all_urls>"] })).toBe(
    true,
  );
  expect(fake.permissions.requests).toEqual([{ origins: ["<all_urls>"] }]);
  expect(
    await chrome.permissions.contains({
      origins: ["https://b.example.test/*"],
    }),
  ).toBe(true);
  fake.permissions.answer = false;
  expect(await chrome.permissions.request({ permissions: ["tabs"] })).toBe(
    false,
  );
  expect(await chrome.permissions.contains({ permissions: ["tabs"] })).toBe(
    false,
  );
});

test("executeScript with frameIds is recorded and can be refused per frame", async () => {
  await chrome.scripting.executeScript({
    target: { tabId: 4, frameIds: [0, 2] },
    files: ["content.js"],
  });
  expect(fake.scripting.executed).toHaveLength(1);
  expect(fake.scripting.executed[0]?.target).toEqual({
    tabId: 4,
    frameIds: [0, 2],
  });
  fake.scripting.refuseFrames = [2];
  await expect(
    chrome.scripting.executeScript({
      target: { tabId: 4, frameIds: [2] },
      files: ["content.js"],
    }),
  ).rejects.toThrow();
});

test("restartServiceWorker keeps storage.session and attached debuggers and drops listeners", async () => {
  await chrome.storage.session.set({ recording: { id: "d1" } });
  await chrome.debugger.attach({ tabId: 7 }, "1.3");
  chrome.runtime.onMessage.addListener(() => undefined);
  fake.restartServiceWorker();
  expect(
    await chrome.storage.session.get<Record<string, unknown>>("recording"),
  ).toEqual({ recording: { id: "d1" } });
  expect(fake.debugger.attached).toEqual([{ tabId: 7 }]);
  await expect(chrome.runtime.sendMessage({ type: "x" })).rejects.toThrow(
    "Receiving end does not exist",
  );
});

test("alarms.create is recorded and alarms.fire reaches an onAlarm listener", async () => {
  const fired: string[] = [];
  chrome.alarms.onAlarm.addListener((alarm) => fired.push(alarm.name));
  await chrome.alarms.create("keep-alive", { periodInMinutes: 0.5 });
  expect(fake.alarms.created.get("keep-alive")).toEqual({
    periodInMinutes: 0.5,
  });
  fake.alarms.fire("keep-alive");
  expect(fired).toEqual(["keep-alive"]);
});

test("uninstall removes globalThis.chrome", () => {
  fake.uninstall();
  expect("chrome" in globalThis).toBe(false);
  fake = installChromeFake();
});

test("calls lists tabCapture.getMediaStreamId before a later port message in the order they happened", async () => {
  const far = fake.connectFrom("recorder:offscreen", { id: "x" });
  await chrome.tabCapture.getMediaStreamId({ targetTabId: 3 });
  far.postMessage({ type: "offscreen.ready" });
  const capture = fake.calls.indexOf("tabCapture.getMediaStreamId");
  const message = fake.calls.indexOf("port:recorder:offscreen offscreen.ready");
  expect(capture).toBeGreaterThanOrEqual(0);
  expect(message).toBeGreaterThan(capture);
  expect(fake.tabCapture.calls).toEqual([{ targetTabId: 3 }]);
  chrome.runtime.getURL("a.html");
  chrome.runtime.getManifest();
  expect(fake.calls).toContain("runtime.getURL");
  expect(fake.calls).toContain("runtime.getManifest");
});

test("addListener is recorded as <namespace>.<event>.addListener", () => {
  chrome.runtime.onMessage.addListener(() => undefined);
  chrome.debugger.onEvent.addListener(() => undefined);
  chrome.webNavigation.onCommitted.addListener(() => undefined);
  expect(fake.calls).toEqual([
    "runtime.onMessage.addListener",
    "debugger.onEvent.addListener",
    "webNavigation.onCommitted.addListener",
  ]);
});

test("debugger drivers answer commands, emit events and detach with a reason", async () => {
  const events: unknown[] = [];
  const detaches: unknown[] = [];
  chrome.debugger.onEvent.addListener((source, method, params) =>
    events.push([source, method, params]),
  );
  chrome.debugger.onDetach.addListener((source, reason) =>
    detaches.push([source, reason]),
  );
  await expect(
    chrome.debugger.sendCommand({ tabId: 1 }, "Network.enable"),
  ).rejects.toThrow();
  await chrome.debugger.attach({ tabId: 1 }, "1.3");
  fake.debugger.respond("Network.getResponseBody", (params) => ({
    body: JSON.stringify(params),
  }));
  expect(
    await chrome.debugger.sendCommand({ tabId: 1 }, "Network.getResponseBody", {
      requestId: "r",
    }),
  ).toEqual({
    body: '{"requestId":"r"}',
  });
  fake.debugger.emit({ tabId: 1 }, "Network.requestWillBeSent", {
    requestId: "r",
  });
  fake.debugger.detach({ tabId: 1 }, "canceled_by_user");
  expect(events).toEqual([
    [{ tabId: 1 }, "Network.requestWillBeSent", { requestId: "r" }],
  ]);
  expect(detaches).toEqual([[{ tabId: 1 }, "canceled_by_user"]]);
  expect(fake.debugger.attached).toEqual([]);
  fake.debugger.refuseAttach = "Cannot attach to this target.";
  await expect(chrome.debugger.attach({ tabId: 1 }, "1.3")).rejects.toThrow(
    "Cannot attach",
  );
});

test("sendFromPage and sendExternal reach their listeners and resolve the response", async () => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    sendResponse({ echoed: message });
    return true;
  });
  chrome.runtime.onMessageExternal.addListener(
    (_message, sender, sendResponse) => {
      sendResponse({ origin: sender.origin });
    },
  );
  expect(await fake.sendFromPage({ type: "page.state" })).toEqual({
    echoed: { type: "page.state" },
  });
  expect(
    await fake.sendExternal(
      { type: "openbot.ping" },
      { origin: "https://openbot.example.test" },
    ),
  ).toEqual({
    origin: "https://openbot.example.test",
  });
});

test("offscreen, native, badge, tabs and webNavigation behave as the plan's APIs do", async () => {
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
    justification: "x",
  });
  await expect(
    chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
      justification: "x",
    }),
  ).rejects.toThrow("single offscreen");
  expect(fake.offscreen.open).toBe(true);
  await chrome.offscreen.closeDocument();
  expect(fake.offscreen.open).toBe(false);

  await expect(
    chrome.runtime.sendNativeMessage("host", { type: "ping" }),
  ).rejects.toThrow("not found");
  fake.native.reply = () => ({ ok: true });
  expect(
    await chrome.runtime.sendNativeMessage("host", { type: "ping" }),
  ).toEqual({ ok: true });
  expect(fake.native.sent).toEqual([{ type: "ping" }, { type: "ping" }]);

  await chrome.action.setBadgeText({ text: "12" });
  await chrome.action.setBadgeBackgroundColor({ color: "#112233" });
  expect(fake.badge).toEqual({ text: "12", color: "#112233" });

  const created = await chrome.tabs.create({ url: "https://x.example.test/" });
  expect(fake.opened).toEqual(["https://x.example.test/"]);
  expect((await chrome.tabs.get(created.id as number)).url).toBe(
    "https://x.example.test/",
  );
  await chrome.tabs.update(created.id as number, { active: false });
  expect(fake.updated).toEqual([
    { tabId: created.id as number, props: { active: false } },
  ]);
  expect(await chrome.tabs.query({ active: true })).toEqual([]);

  const commits: unknown[] = [];
  chrome.webNavigation.onCommitted.addListener((details) =>
    commits.push(details),
  );
  fake.webNavigation.commit({ tabId: 5, url: "https://x.example.test/a" });
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({
    tabId: 5,
    frameId: 0,
    url: "https://x.example.test/a",
  });
});
