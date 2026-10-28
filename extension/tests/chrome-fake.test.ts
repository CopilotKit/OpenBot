import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

test("a port opened with connectFrom delivers to onConnect listeners and carries messages both ways", async () => {
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
  await Promise.resolve();
  expect(received).toEqual([{ type: "offscreen.ready" }]);
  expect(far.messages).toEqual([{ type: "offscreen.start" }]);
  expect(fake.calls).toContain("port:recorder:offscreen offscreen.ready");
  expect(fake.calls).toContain("port:recorder:offscreen offscreen.start");
  swPort?.disconnect();
  await Promise.resolve();
  expect(far.onDisconnect.called).toBe(true);
});

test("an onMessage listener reached through sendFromPage sees an extension page sender", async () => {
  let seen: chrome.runtime.MessageSender | undefined;
  chrome.runtime.onMessage.addListener((_message, sender) => {
    seen = sender;
  });
  await fake.sendFromPage({ type: "x" });
  expect(seen?.id).toBe(chrome.runtime.id);
  expect(seen?.url?.startsWith(chrome.runtime.getURL(""))).toBe(true);
  expect(seen?.origin).toBe(`chrome-extension://${chrome.runtime.id}`);
});

test("sendFromPage merges a sender override over the extension page default", async () => {
  let seen: chrome.runtime.MessageSender | undefined;
  chrome.runtime.onMessage.addListener((_message, sender) => {
    seen = sender;
  });
  await fake.sendFromPage(
    { type: "x" },
    { url: "https://evil.test/", origin: "https://evil.test" },
  );
  expect(seen?.url).toBe("https://evil.test/");
  expect(seen?.origin).toBe("https://evil.test");
  expect(seen?.id).toBe(chrome.runtime.id);
});

test("a message the worker posts inside onConnect reaches a listener added right after connect returns", async () => {
  chrome.runtime.onConnect.addListener((port) => {
    port.postMessage({ type: "sw.hello" });
  });
  const port = chrome.runtime.connect({ name: "recorder:popup" });
  const received: unknown[] = [];
  port.onMessage.addListener((message) => received.push(message));
  expect(received).toEqual([]);
  await Promise.resolve();
  expect(received).toEqual([{ type: "sw.hello" }]);
});

test("port messages arrive in order and before a later disconnect", async () => {
  const order: string[] = [];
  chrome.runtime.onConnect.addListener((port) => {
    port.postMessage("a");
    port.postMessage("b");
    port.disconnect();
  });
  const port = chrome.runtime.connect({ name: "p" });
  port.onMessage.addListener((m) => order.push(String(m)));
  port.onDisconnect.addListener(() => order.push("disconnect"));
  await Promise.resolve();
  expect(order).toEqual(["a", "b", "disconnect"]);
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

test("calls lists a chrome call before a later port message in the order they happened", async () => {
  chrome.runtime.onConnect.addListener(() => undefined);
  const far = fake.connectFrom("recorder:offscreen", { id: "x" });
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["LOCAL_STORAGE"] as chrome.offscreen.Reason[],
    justification: "test",
  });
  far.postMessage({ type: "offscreen.ready" });
  const created = fake.calls.indexOf("offscreen.createDocument");
  const message = fake.calls.indexOf("port:recorder:offscreen offscreen.ready");
  expect(created).toBeGreaterThanOrEqual(0);
  expect(message).toBeGreaterThan(created);
  chrome.runtime.getURL("a.html");
  chrome.runtime.getManifest();
  expect(fake.calls).toContain("runtime.getURL");
  expect(fake.calls).toContain("runtime.getManifest");
});

test("the fake offers no screen capture: the Recorder records no screen", () => {
  expect("tabCapture" in chrome).toBe(false);
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

test("tabs and windows the person uses are reported in the order Chrome reports them", async () => {
  // Measured on Playwright's Chromium 151, headless, with an extension logging each event: a new tab is created and
  // then activated, a tab switched to is activated, and a window brought to the front reports its focus and no tab.
  const seen: string[] = [];
  chrome.tabs.onCreated.addListener((tab) =>
    seen.push(`created ${tab.id} active=${tab.active} url=${tab.url}`),
  );
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
    seen.push(`activated ${tabId} window ${windowId}`),
  );
  chrome.windows.onFocusChanged.addListener((windowId) =>
    seen.push(`focus ${windowId}`),
  );
  fake.tabs.set(1, {
    id: 1,
    windowId: 1,
    active: true,
    url: "https://a.example.test/",
  } as chrome.tabs.Tab);
  const opened = fake.person.openTab();
  fake.person.switchTo(1);
  fake.person.focusWindow(2);
  fake.person.focusWindow(chrome.windows.WINDOW_ID_NONE);
  const created = await chrome.tabs.create({ url: "https://b.example.test/" });
  expect(seen).toEqual([
    `created ${opened.id} active=true url=undefined`,
    `activated ${opened.id} window 1`,
    "activated 1 window 1",
    "focus 2",
    "focus -1",
    `created ${created.id} active=true url=https://b.example.test/`,
    `activated ${created.id} window 1`,
  ]);
  // One active tab per window, as in Chrome.
  expect(
    (await chrome.tabs.query({ active: true, windowId: 1 })).map(
      (tab) => tab.id,
    ),
  ).toEqual([created.id]);
  await chrome.tabs.update(1, { active: true });
  expect(seen.at(-1)).toBe("activated 1 window 1");
  expect(
    (await chrome.tabs.query({ active: true, windowId: 1 })).map(
      (tab) => tab.id,
    ),
  ).toEqual([1]);
});

test("runtime.connect with no onConnect listener fires its onDisconnect", async () => {
  const port = chrome.runtime.connect({ name: "p" });
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  expect(disconnected).toBe(false);
  await Promise.resolve();
  expect(disconnected).toBe(true);
});

test("connectFrom with no onConnect listener reports onDisconnect.called after a microtask", async () => {
  const far = fake.connectFrom("recorder:offscreen", { id: "x" });
  await Promise.resolve();
  expect(far.onDisconnect.called).toBe(true);
});

test("a port message is copied as JSON: a Set arrives as an empty object", async () => {
  let swPort: chrome.runtime.Port | undefined;
  const received: unknown[] = [];
  chrome.runtime.onConnect.addListener((port) => {
    swPort = port;
    port.onMessage.addListener((message) => received.push(message));
  });
  const far = fake.connectFrom("p", { id: "x" });
  far.postMessage({ s: new Set(["a"]) });
  swPort?.postMessage({ s: new Set(["a"]) });
  await Promise.resolve();
  expect(received).toEqual([{ s: {} }]);
  expect(far.messages).toEqual([{ s: {} }]);
});

test("mutating a posted message after postMessage leaves the delivered copy unchanged", async () => {
  let swPort: chrome.runtime.Port | undefined;
  chrome.runtime.onConnect.addListener((port) => {
    swPort = port;
  });
  const far = fake.connectFrom("p", { id: "x" });
  const sent = { list: [1] };
  swPort?.postMessage(sent);
  sent.list.push(2);
  await Promise.resolve();
  expect(far.messages).toEqual([{ list: [1] }]);
});

test("sendMessage and sendExternal hand listeners a JSON copy and copy the response", async () => {
  const seen: unknown[] = [];
  const reply = { nested: [1] };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    seen.push(message);
    sendResponse(reply);
  });
  chrome.runtime.onMessageExternal.addListener(
    (message, _sender, sendResponse) => {
      seen.push(message);
      sendResponse({ s: new Set(["a"]) });
    },
  );
  const sent = { s: new Set(["a"]), n: 1 };
  const answer = (await fake.sendFromPage(sent)) as typeof reply;
  expect(seen[0]).toEqual({ s: {}, n: 1 });
  expect(seen[0]).not.toBe(sent);
  expect(answer).toEqual({ nested: [1] });
  expect(answer).not.toBe(reply);
  expect(await fake.sendExternal({ s: new Set(["a"]) }, { id: "x" })).toEqual({
    s: {},
  });
  expect(seen[1]).toEqual({ s: {} });
});

test("sendMessage, sendFromPage and sendExternal deliver to listeners asynchronously", async () => {
  const order: string[] = [];
  chrome.runtime.onMessage.addListener(() => {
    order.push("listener");
  });
  chrome.runtime.onMessageExternal.addListener(() => {
    order.push("external");
  });
  const viaSend = chrome.runtime.sendMessage({ type: "a" });
  order.push("after sendMessage");
  await viaSend;
  const viaPage = fake.sendFromPage({ type: "b" });
  order.push("after sendFromPage");
  await viaPage;
  const viaExternal = fake.sendExternal({ type: "c" }, { id: "x" });
  order.push("after sendExternal");
  await viaExternal;
  expect(order).toEqual([
    "after sendMessage",
    "listener",
    "after sendFromPage",
    "listener",
    "after sendExternal",
    "external",
  ]);
});

test("storage keeps only JSON values: a Set becomes {} and a Date becomes a string", async () => {
  const when = new Date("2026-01-02T03:04:05.000Z");
  const read = (area: unknown, keys: string[]) =>
    (area as { get(keys: string[]): Promise<unknown> }).get(keys);
  await chrome.storage.local.set({ s: new Set(["a"]), d: when });
  expect(await read(chrome.storage.local, ["s", "d"])).toEqual({
    s: {},
    d: when.toISOString(),
  });
  fake.storage.setManaged({ m: new Map([["k", 1]]) });
  expect(await read(chrome.storage.managed, ["m"])).toEqual({ m: {} });
});

test("runtime.sendMessage supports Chrome's callback form and answers the callback with the response", async () => {
  chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
    return true;
  });
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "x" }, resolve);
  });
  expect(response).toEqual({ ok: true });
  const viaOptions = await new Promise((resolve) => {
    (chrome.runtime.sendMessage as (...args: unknown[]) => void)(
      { type: "x" },
      {},
      resolve,
    );
  });
  expect(viaOptions).toEqual({ ok: true });
});

test("runtime.sendMessage with a callback and no listener sets lastError for the callback only", async () => {
  let seen: unknown = "unset";
  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: "x" }, () => {
      seen = chrome.runtime.lastError;
      resolve();
    });
  });
  expect(seen).toEqual({
    message: "Could not establish connection. Receiving end does not exist.",
  });
  expect(chrome.runtime.lastError).toBeUndefined();
});

test("runtime.sendMessage ignores a sender-like second argument and keeps the extension page sender", async () => {
  let seen: chrome.runtime.MessageSender | undefined;
  chrome.runtime.onMessage.addListener((_message, sender) => {
    seen = sender;
  });
  await (
    chrome.runtime.sendMessage as (...args: unknown[]) => Promise<unknown>
  )({ type: "x" }, { tab: { id: 9 } });
  expect(seen?.tab).toBeUndefined();
  await fake.sendFromPage({ type: "x" }, { tab: { id: 9 } as chrome.tabs.Tab });
  expect(seen?.tab?.id).toBe(9);
});

test("storage set reports a change only when the value differs and omits oldValue for a new key", async () => {
  const seen: Record<string, chrome.storage.StorageChange>[] = [];
  chrome.storage.onChanged.addListener((changes) => seen.push(changes));
  await chrome.storage.local.set({ k: { a: 1 } });
  await chrome.storage.local.set({ k: { a: 1 } });
  expect(seen).toHaveLength(1);
  expect("oldValue" in (seen[0]?.k ?? {})).toBe(false);
  await chrome.storage.local.set({ k: { a: 2 } });
  expect(seen).toHaveLength(2);
  expect(seen[1]?.k?.oldValue).toEqual({ a: 1 });
});

test("onDisconnect.called is false on the end that disconnected and true once the other side does", async () => {
  let swPort: chrome.runtime.Port | undefined;
  chrome.runtime.onConnect.addListener((port) => {
    swPort = port;
  });
  const far = fake.connectFrom("p", { id: "x" });
  far.disconnect();
  await Promise.resolve();
  expect(far.onDisconnect.called).toBe(false);

  const far2 = fake.connectFrom("p2", { id: "x" });
  swPort?.disconnect();
  await Promise.resolve();
  expect(far2.onDisconnect.called).toBe(true);
});

test("tabs.remove closes tabs in order, fires onRemoved, and stops at the first unknown id as Chrome does", async () => {
  const ids: number[] = [];
  for (const site of ["a", "b", "c"])
    ids.push(
      (await chrome.tabs.create({ url: `https://${site}.example.test/` }))
        .id as number,
    );
  const [first, second, third] = ids;
  const seen: unknown[] = [];
  chrome.tabs.onRemoved.addListener((tabId, info) => seen.push([tabId, info]));

  await chrome.tabs.remove(first);
  expect(fake.tabs.has(first)).toBe(false);
  await expect(chrome.tabs.get(first)).rejects.toThrow(
    `No tab with id: ${first}.`,
  );
  await expect(chrome.tabs.remove(first)).rejects.toThrow(
    `No tab with id: ${first}.`,
  );

  // Chrome closes each id in turn and answers with the first unknown one: the tabs before it are closed.
  await expect(chrome.tabs.remove([second, 999, third])).rejects.toThrow(
    "No tab with id: 999.",
  );
  expect(fake.tabs.has(second)).toBe(false);
  expect(fake.tabs.has(third)).toBe(true);
  expect(fake.removed).toEqual([first, second]);
  expect(seen).toEqual([
    [first, { windowId: 1, isWindowClosing: false }],
    [second, { windowId: 1, isWindowClosing: false }],
  ]);
  expect(fake.calls.filter((call) => call === "tabs.remove")).toHaveLength(3);
});

const OFFSCREEN_PARAMETERS = {
  url: "offscreen.html",
  reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
  justification: "x",
};

test("offscreen.hasDocument and runtime.getContexts report the document from createDocument until closeDocument", async () => {
  expect(await chrome.offscreen.hasDocument()).toBe(false);
  expect(
    await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }),
  ).toEqual([]);
  await chrome.offscreen.createDocument(OFFSCREEN_PARAMETERS);
  expect(await chrome.offscreen.hasDocument()).toBe(true);
  expect(
    await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }),
  ).toMatchObject([{ contextType: "OFFSCREEN_DOCUMENT" }]);
  await chrome.offscreen.closeDocument();
  expect(await chrome.offscreen.hasDocument()).toBe(false);
  expect(fake.calls.filter((call) => call.startsWith("offscreen."))).toEqual([
    "offscreen.hasDocument",
    "offscreen.createDocument",
    "offscreen.hasDocument",
    "offscreen.closeDocument",
    "offscreen.hasDocument",
  ]);
});

test("a second createDocument and a closeDocument with no document reject with Chrome's exact errors and change nothing", async () => {
  const created: string[] = [];
  let closed = 0;
  fake.offscreen.onDocumentCreated.addListener((parameters) =>
    created.push(parameters.url),
  );
  fake.offscreen.onDocumentClosed.addListener(() => {
    closed++;
  });
  await expect(chrome.offscreen.closeDocument()).rejects.toThrow(
    /^No current offscreen document\.$/,
  );
  expect(closed).toBe(0);
  await chrome.offscreen.createDocument(OFFSCREEN_PARAMETERS);
  await expect(
    chrome.offscreen.createDocument({
      ...OFFSCREEN_PARAMETERS,
      url: "other.html",
    }),
  ).rejects.toThrow(/^Only a single offscreen document may be created\.$/);
  expect(created).toEqual(["offscreen.html"]);
  expect(fake.offscreen.created).toEqual([OFFSCREEN_PARAMETERS]);
  expect(fake.offscreen.open).toBe(true);
  await chrome.offscreen.closeDocument();
  await expect(chrome.offscreen.closeDocument()).rejects.toThrow(
    /^No current offscreen document\.$/,
  );
  expect(closed).toBe(1);
  expect(fake.offscreen.open).toBe(false);
});

test("onDocumentCreated and onDocumentClosed run once per document, with the new state in place, before the call resolves", async () => {
  const seen: string[] = [];
  fake.offscreen.onDocumentCreated.addListener((parameters) =>
    seen.push(`created ${parameters.url} open=${fake.offscreen.open}`),
  );
  fake.offscreen.onDocumentClosed.addListener(() =>
    seen.push(`closed open=${fake.offscreen.open}`),
  );
  await chrome.offscreen.createDocument(OFFSCREEN_PARAMETERS);
  seen.push("createDocument resolved");
  await chrome.offscreen.closeDocument();
  seen.push("closeDocument resolved");
  expect(seen).toEqual([
    "created offscreen.html open=true",
    "createDocument resolved",
    "closed open=false",
    "closeDocument resolved",
  ]);
});

test("the document hooks survive restartServiceWorker, as the document does, and removeListener stops one", async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const onCreated = (parameters: chrome.offscreen.CreateParameters) =>
    created.push(parameters.url);
  fake.offscreen.onDocumentCreated.addListener(onCreated);
  fake.offscreen.onDocumentClosed.addListener(() => closed.push("closed"));
  await chrome.offscreen.createDocument(OFFSCREEN_PARAMETERS);
  fake.restartServiceWorker();
  expect(await chrome.offscreen.hasDocument()).toBe(true);
  await chrome.offscreen.closeDocument();
  expect(closed).toEqual(["closed"]);
  fake.offscreen.onDocumentCreated.removeListener(onCreated);
  await chrome.offscreen.createDocument(OFFSCREEN_PARAMETERS);
  expect(created).toEqual(["offscreen.html"]);
  expect(fake.offscreen.created).toHaveLength(2);
});

// ---- Each context's chrome ---------------------------------------------------------------------

test("an offscreen document's chrome is what Chrome gives one: chrome.runtime with messaging, getURL and id, and nothing else", () => {
  const document = fake.apis["offscreen-document"];
  expect(Object.keys(document)).toEqual(["runtime"]);
  expect(Object.keys(document.runtime).sort()).toEqual([
    "connect",
    "getURL",
    "id",
    "onConnect",
    "onMessage",
    "sendMessage",
  ]);
  expect(
    fake.runAs("offscreen-document", () => "getManifest" in chrome.runtime),
  ).toBe(false);
  expect(fake.runAs("offscreen-document", () => "storage" in chrome)).toBe(
    false,
  );
  expect("getManifest" in chrome.runtime).toBe(true);
});

test("a port the document opens reaches the service worker as the offscreen document's", async () => {
  let sender: chrome.runtime.MessageSender | undefined;
  chrome.runtime.onConnect.addListener((port) => {
    sender = port.sender;
  });
  fake.runAs("offscreen-document", () =>
    chrome.runtime.connect({ name: "recorder:offscreen" }),
  );
  expect(sender?.url).toBe(
    `chrome-extension://${chrome.runtime.id}/offscreen.html`,
  );
});

test("code run as the document keeps its chrome through what it awaits and schedules, and each listener runs in the context it was added in", async () => {
  const seen: string[] = [];
  const has = () => ("getManifest" in chrome.runtime ? "worker" : "document");
  let workerPort: chrome.runtime.Port | undefined;
  chrome.runtime.onConnect.addListener((port) => {
    workerPort = port;
    port.onMessage.addListener(() => seen.push(`worker heard: ${has()}`));
  });
  await fake.runAs("offscreen-document", async () => {
    const port = chrome.runtime.connect({ name: "recorder:offscreen" });
    port.onMessage.addListener(() => seen.push(`document heard: ${has()}`));
    await Promise.resolve();
    seen.push(`after an await: ${has()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    seen.push(`after a timer: ${has()}`);
    port.postMessage({ type: "offscreen.ready" });
  });
  workerPort?.postMessage({ type: "offscreen.start" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen).toEqual([
    "after an await: document",
    "after a timer: document",
    "worker heard: worker",
    "document heard: document",
  ]);
});

test("a file of the document's code names it as the default context; the worker's chrome stays in reach", () => {
  fake.uninstall();
  fake = installChromeFake({ context: "offscreen-document" });
  expect("getManifest" in chrome.runtime).toBe(false);
  expect(fake.apis["service-worker"].runtime.getManifest().version).toBe(
    "0.0.0",
  );
  expect(fake.runAs("service-worker", () => "storage" in chrome)).toBe(true);
});

test("a test that sets its own chrome replaces the fake, and uninstall leaves none", () => {
  const own = { runtime: { id: "own" } };
  (globalThis as unknown as { chrome: unknown }).chrome = own;
  expect(globalThis.chrome as unknown).toBe(own);
  fake.uninstall();
  expect("chrome" in globalThis).toBe(false);
  fake = installChromeFake();
});

test("code one browser's listener ran keeps that browser after another is installed, as one Chrome's extension never reaches another's", async () => {
  // A test's service worker still finishing its last Stop when the next test installed its browser closed that test's
  // document through the `chrome` it then saw (held-steps.test.ts).
  const first = fake;
  const later = Promise.withResolvers<void>();
  chrome.runtime.onMessage.addListener(() => {
    void later.promise.then(async () => {
      await chrome.storage.local.set({ wrote: "the first browser's worker" });
      if (await chrome.offscreen.hasDocument())
        await chrome.offscreen.closeDocument();
    });
  });
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["LOCAL_STORAGE"],
    justification: "test",
  });
  await fake.sendFromPage({ type: "page.state" });
  first.uninstall();
  const next = installChromeFake();
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["LOCAL_STORAGE"],
    justification: "test",
  });
  later.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(first.storage.local.get("wrote")).toBe("the first browser's worker");
  expect(next.storage.local.get("wrote")).toBeUndefined();
  expect({ first: first.offscreen.open, next: next.offscreen.open }).toEqual({
    first: false,
    next: true,
  });
  // A test's own code, which no browser's listener ran, sees the browser installed last.
  expect(chrome).toBe(next.apis["service-worker"]);
  fake = next;
});
