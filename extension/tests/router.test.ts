import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import * as connection from "../src/background/connection";
import type { NetworkCaptureDeps } from "../src/background/network";
import { installRecording } from "../src/background/recording";
import { recoverInterruptedRecording } from "../src/background/recovery";
import { installRouter, type RouterHandlers } from "../src/background/router";
import type {
  ExternalToBackground,
  PageToBackground,
  RecorderState,
  StreamSession,
} from "../src/protocol/messages";
import {
  IDLE_STATE,
  PORT_CONTENT,
  PORT_OFFSCREEN,
} from "../src/protocol/messages";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
let seen: {
  page: PageToBackground[];
  external: ExternalToBackground[];
  content: chrome.runtime.Port[];
  offscreen: chrome.runtime.Port[];
  order: string[];
};
let handlers: RouterHandlers & {
  current(): Promise<RecorderState>;
  connected(): Promise<void>;
  disconnected(): Promise<void>;
  connectionLost(): Promise<void>;
};
let id: string;
let restore: (() => void)[];

beforeEach(() => {
  fake = installChromeFake();
  id = chrome.runtime.id;
  restore = [];
  seen = { page: [], external: [], content: [], offscreen: [], order: [] };
  handlers = {
    page: async (message) => {
      seen.page.push(message);
      return { ok: true };
    },
    external: async (message) => {
      seen.external.push(message);
      return { ok: true };
    },
    contentPort: (port) => seen.content.push(port),
    offscreenPort: (port) => seen.offscreen.push(port),
    current: async () => IDLE_STATE,
    connected: async () => {
      seen.order.push("connected");
    },
    disconnected: async () => {
      seen.order.push("disconnected");
    },
    connectionLost: async () => {
      seen.order.push("connectionLost");
    },
  };
});

afterEach(() => {
  for (const undo of restore) undo();
  fake.uninstall();
});

function stubConnection(
  answer: Awaited<ReturnType<typeof connection.handleConnectionMessage>>,
) {
  const spy = spyOn(connection, "handleConnectionMessage").mockImplementation(
    async () => {
      seen.order.push("connection");
      return answer;
    },
  );
  restore.push(() => spy.mockRestore());
}

test("registers exactly one onMessage, onMessageExternal and onConnect listener", () => {
  installRouter(handlers);
  for (const name of [
    "runtime.onMessage.addListener",
    "runtime.onMessageExternal.addListener",
    "runtime.onConnect.addListener",
  ])
    expect(fake.calls.filter((call) => call === name)).toHaveLength(1);
});

test("recording messages from the extension's own pages go to the recording handler", async () => {
  installRouter(handlers);
  const messages: PageToBackground[] = [
    { type: "page.state" },
    { type: "page.learning" },
    {
      type: "page.record",
      title: "t",
      tabId: 1,
    },
    { type: "page.stop" },
    { type: "page.restart" },
    { type: "page.notice", choice: "stop" },
    { type: "page.notice.dismiss" },
    { type: "page.kept.discard" },
  ];
  for (const message of messages)
    expect(await fake.sendFromPage(message)).toEqual({ ok: true });
  expect(seen.page).toEqual(messages);
});

test("connection messages go to the connection handler, not recording", async () => {
  installRouter(handlers);
  expect(await fake.sendFromPage({ type: "page.connect.pending" })).toEqual({
    ok: true,
    pending: null,
  });
  expect(await fake.sendFromPage({ type: "page.desktop.available" })).toEqual({
    ok: true,
    available: false,
  });
  expect(seen.page).toEqual([]);
});

test("an ok page.connect.decide calls connected() after the connection answered", async () => {
  stubConnection({ ok: true });
  installRouter(handlers);
  await fake.sendFromPage({
    type: "page.connect.decide",
    approve: true,
    label: "x",
    origin: "https://openbot.example.test",
  });
  expect(seen.order).toEqual(["connection", "connected"]);
});

test("OpenBot Desktop's connect calls connected() once it connected this browser, as an approved Connect does, and not when it did not", async () => {
  stubConnection({ ok: true, connected: true });
  installRouter(handlers);
  expect(await fake.sendFromPage({ type: "page.connect.desktop" })).toEqual({
    ok: true,
    connected: true,
  });
  expect(seen.order).toEqual(["connection", "connected"]);

  restore.pop()?.();
  seen.order = [];
  stubConnection({ ok: true, connected: false, reason: "not-signed-in" });
  expect(await fake.sendFromPage({ type: "page.connect.desktop" })).toEqual({
    ok: true,
    connected: false,
    reason: "not-signed-in",
  });
  expect(seen.order).toEqual(["connection"]);
});

test("a refused page.connect.decide does not call connected()", async () => {
  stubConnection({ ok: false, error: "no" });
  installRouter(handlers);
  expect(
    await fake.sendFromPage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
      origin: "https://openbot.example.test",
    }),
  ).toEqual({ ok: false, error: "no" });
  expect(seen.order).toEqual(["connection"]);
});

test("a rejected page.connect.decide (Cancel) answers ok but does not call connected()", async () => {
  stubConnection({ ok: true });
  installRouter(handlers);
  expect(
    await fake.sendFromPage({
      type: "page.connect.decide",
      approve: false,
      label: "x",
      origin: "https://openbot.example.test",
    }),
  ).toEqual({ ok: true });
  expect(seen.order).toEqual(["connection"]);
});

test("a page.connect.decide without the origin its tab shows is unknown and never reaches the connection handler", async () => {
  stubConnection({ ok: true });
  installRouter(handlers);
  expect(
    await fake.sendFromPage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
    }),
  ).toEqual({ ok: false, error: "Unknown request." });
  expect(seen.order).toEqual([]);
});

test("a connected() that throws does not fail the page", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  restore.push(() => error.mockRestore());
  stubConnection({ ok: true });
  handlers.connected = async () => {
    throw new Error("boom");
  };
  installRouter(handlers);
  expect(
    await fake.sendFromPage({
      type: "page.connect.decide",
      approve: true,
      label: "x",
      origin: "https://openbot.example.test",
    }),
  ).toEqual({ ok: true });
  expect(error).toHaveBeenCalled();
});

test("a disconnected() that throws does not fail the page", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  restore.push(() => error.mockRestore());
  stubConnection({ ok: true });
  handlers.disconnected = async () => {
    throw new Error("boom");
  };
  installRouter(handlers);
  expect(await fake.sendFromPage({ type: "page.disconnect" })).toEqual({
    ok: true,
  });
  expect(error).toHaveBeenCalled();
});

test("a content port's disconnect listeners receive the wrapped port", async () => {
  let given: chrome.runtime.Port | undefined;
  const got: chrome.runtime.Port[] = [];
  handlers.contentPort = (port) => {
    given = port;
    port.onDisconnect.addListener((p) => got.push(p));
  };
  installRouter(handlers);
  const far = fake.connectFrom(PORT_CONTENT, {
    id,
    tab: { id: 3 } as chrome.tabs.Tab,
  });
  far.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(got).toHaveLength(1);
  expect(got[0]).toBe(given as chrome.runtime.Port);
});

test("page.disconnect calls disconnected() after the connection answered", async () => {
  stubConnection({ ok: true });
  installRouter(handlers);
  await fake.sendFromPage({ type: "page.disconnect" });
  expect(seen.order).toEqual(["connection", "disconnected"]);
});

test("an unknown page message gets an Unknown request answer", async () => {
  installRouter(handlers);
  expect(await fake.sendFromPage({ type: "page.nope" })).toEqual({
    ok: false,
    error: "Unknown request.",
  });
  expect(await fake.sendFromPage("garbage")).toEqual({
    ok: false,
    error: "Unknown request.",
  });
  expect(seen.page).toEqual([]);
});

test("RECORDER_E2E_FLOOD is unknown outside the e2e variant", async () => {
  installRouter(handlers);
  expect(
    await fake.sendFromPage({ type: "RECORDER_E2E_FLOOD", count: 3 }),
  ).toEqual({ ok: false, error: "Unknown request." });
  expect(seen.page).toEqual([]);
});

test("RECORDER_E2E_FLOOD reaches the recording handler in the e2e variant", async () => {
  const previous = process.env.RECORDER_VARIANT;
  process.env.RECORDER_VARIANT = "e2e";
  try {
    installRouter(handlers);
    expect(
      await fake.sendFromPage({ type: "RECORDER_E2E_FLOOD", count: 3 }),
    ).toEqual({ ok: true });
    expect(seen.page).toEqual([{ type: "RECORDER_E2E_FLOOD", count: 3 }]);
  } finally {
    if (previous === undefined) delete process.env.RECORDER_VARIANT;
    else process.env.RECORDER_VARIANT = previous;
  }
});

test("a page message from a web origin or another extension is refused", async () => {
  installRouter(handlers);
  const web = {
    id,
    url: "https://evil.example.test/",
    origin: "https://evil.example.test",
  };
  const other = {
    id: "otherextension",
    url: `chrome-extension://${id}/popup.html`,
  };
  const noUrl = { id, url: undefined };
  for (const sender of [web, other, noUrl]) {
    const answer = (await fake.sendFromPage(
      { type: "page.state" },
      sender,
    )) as {
      ok: boolean;
    };
    expect(answer.ok).toBe(false);
  }
  expect(seen.page).toEqual([]);
});

test("a handler that throws answers with an error instead of hanging", async () => {
  handlers.page = async () => {
    throw new Error("boom");
  };
  installRouter(handlers);
  const answer = (await fake.sendFromPage({ type: "page.state" })) as {
    ok: boolean;
  };
  expect(answer.ok).toBe(false);
});

test("openbot.ping and openbot.connect from a web page go to the external connect handler", async () => {
  const spy = spyOn(connection, "handleExternalConnect").mockImplementation(
    async (message) => {
      seen.external.push(message);
      return { ok: true };
    },
  );
  restore.push(() => spy.mockRestore());
  installRouter(handlers);
  const sender = {
    url: "https://openbot.example.test/x",
    origin: "https://openbot.example.test",
  };
  await fake.sendExternal({ type: "openbot.ping" }, sender);
  await fake.sendExternal({ type: "openbot.connect", code: "obc_abc" }, sender);
  expect(seen.external).toEqual([
    { type: "openbot.ping" },
    { type: "openbot.connect", code: "obc_abc" },
  ]);
});

test("a trusted OpenBot's connect, made with no Connect page, is followed up as an approved Connect is, and one waiting on its page is not", async () => {
  const answers = [
    {
      ok: true as const,
      version: "0.3.0",
      installId: "i",
      connected: true as const,
    },
    {
      ok: true as const,
      version: "0.3.0",
      installId: "i",
      awaitingConfirmation: true,
    },
  ];
  const spy = spyOn(connection, "handleExternalConnect").mockImplementation(
    async () => {
      seen.order.push("connection");
      return answers.shift() ?? { ok: false, error: "invalid" };
    },
  );
  restore.push(() => spy.mockRestore());
  installRouter(handlers);
  const sender = {
    url: "http://127.0.0.1:3010/",
    origin: "http://127.0.0.1:3010",
  };
  expect(
    await fake.sendExternal({ type: "openbot.connect", code: "obc_a" }, sender),
  ).toMatchObject({ ok: true, connected: true });
  expect(seen.order).toEqual(["connection", "connected"]);
  expect(
    await fake.sendExternal({ type: "openbot.connect", code: "obc_b" }, sender),
  ).toMatchObject({ ok: true, awaitingConfirmation: true });
  expect(seen.order).toEqual(["connection", "connected", "connection"]);
});

test("openbot.state, openbot.record and openbot.stop are answered for OpenBot's page and never reach the connect handler or the page-network entry", async () => {
  const spy = spyOn(connection, "handleExternalConnect");
  restore.push(() => spy.mockRestore());
  installRouter(handlers);
  const sender = {
    url: "https://openbot.example.test/",
    origin: "https://openbot.example.test",
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
  };
  // Nothing is connected: the page is told so, and nothing records.
  expect(await fake.sendExternal({ type: "openbot.state" }, sender)).toEqual({
    connected: false,
  });
  for (const message of [
    { type: "openbot.record", title: "Archive order 1043" },
    { type: "openbot.stop" },
  ])
    expect(await fake.sendExternal(message, sender)).toEqual({
      ok: false,
      error: "Connect this browser to OpenBot first.",
    });
  // Malformed: answered invalid before anything reads it.
  for (const message of [
    { type: "openbot.record", title: "   " },
    { type: "openbot.record", title: "x".repeat(201) },
    { type: "openbot.record", title: "x", tabId: 9 },
    { type: "openbot.state", origin: "https://openbot.example.test" },
  ])
    expect(await fake.sendExternal(message, sender)).toEqual({
      ok: false,
      error: "invalid",
    });
  expect(spy).not.toHaveBeenCalled();
  expect(seen.external).toEqual([]);
  expect(seen.page).toEqual([]);
});

test("recorder.page-network goes to the recording handler's external entry", async () => {
  installRouter(handlers);
  const event = {
    type: "CUSTOM" as const,
    name: "network",
    timestamp: 1,
    value: { a: 1 },
  };
  const answer = await fake.sendExternal(
    { type: "recorder.page-network", event },
    { tab: { id: 7 } as chrome.tabs.Tab, url: "https://site.example.test/" },
  );
  expect(answer).toEqual({ ok: true });
  expect(seen.external).toEqual([{ type: "recorder.page-network", event }]);
});

test("a malformed external message is answered invalid without reaching a handler", async () => {
  installRouter(handlers);
  expect(
    await fake.sendExternal(
      { type: "openbot.connect", code: "not-a-code" },
      { origin: "https://openbot.example.test" },
    ),
  ).toEqual({ ok: false, error: "invalid" });
  expect(await fake.sendExternal({ nope: 1 }, {})).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(seen.external).toEqual([]);
});

test("a content port reaches the content handler and malformed messages are dropped without throwing", async () => {
  const received: unknown[] = [];
  handlers.contentPort = (port) => {
    seen.content.push(port);
    port.onMessage.addListener((message) => received.push(message));
  };
  installRouter(handlers);
  const far = fake.connectFrom(PORT_CONTENT, {
    id,
    tab: { id: 3 } as chrome.tabs.Tab,
  });
  far.postMessage({ type: "content.hello", top: true, url: "https://a.test/" });
  far.postMessage({ type: "content.nope" });
  far.postMessage("garbage");
  far.postMessage({ type: "content.notice", choice: "stop", extra: 1 });
  far.postMessage({ type: "content.notice", choice: "continue" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen.content).toHaveLength(1);
  expect(received).toEqual([
    { type: "content.hello", top: true, url: "https://a.test/" },
    { type: "content.notice", choice: "continue" },
  ]);
});

test("the offscreen port is accepted only from offscreen.html", async () => {
  installRouter(handlers);
  const good = fake.connectFrom(PORT_OFFSCREEN, {
    id,
    url: `chrome-extension://${id}/offscreen.html`,
  });
  const wrongPage = fake.connectFrom(PORT_OFFSCREEN, {
    id,
    url: `chrome-extension://${id}/popup.html`,
  });
  const wrongId = fake.connectFrom(PORT_OFFSCREEN, {
    id: "other",
    url: `chrome-extension://other/offscreen.html`,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen.offscreen).toHaveLength(1);
  expect(good.onDisconnect.called).toBe(false);
  expect(wrongPage.onDisconnect.called).toBe(true);
  expect(wrongId.onDisconnect.called).toBe(true);
});

test("a port with an unknown name is disconnected", async () => {
  installRouter(handlers);
  const far = fake.connectFrom("recorder:other", { id });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(far.onDisconnect.called).toBe(true);
  expect(seen.content).toEqual([]);
  expect(seen.offscreen).toEqual([]);
});

test("importing the service worker's index registers each listener once and closes storage.local to content scripts", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory;
    IDBKeyRange: typeof FakeIDBKeyRange;
  };
  const saved = {
    indexedDB: globals.indexedDB,
    IDBKeyRange: globals.IDBKeyRange,
  };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  try {
    await import(`../src/background/index?once-${Math.random()}`);
    for (const name of [
      "runtime.onMessage.addListener",
      "runtime.onMessageExternal.addListener",
      "runtime.onConnect.addListener",
      "runtime.onStartup.addListener",
    ])
      expect(fake.calls.filter((call) => call === name)).toHaveLength(1);
    await Bun.sleep(0);
    expect(fake.storage.accessLevel).toBe("TRUSTED_CONTEXTS");
  } finally {
    globals.indexedDB = saved.indexedDB;
    globals.IDBKeyRange = saved.IDBKeyRange;
  }
});

test("a recorder.page-network event the fallback accepts reaches the network capture, not the offscreen document", async () => {
  const recordingId = "rec-9";
  const trajectoryId = "00000000-0000-4000-8000-000000000009";
  const startedAt = 1_800_000_000_000;
  const event: CapturedEvent = {
    type: "CUSTOM",
    name: "network",
    timestamp: 1,
    value: { url: "https://crm.example.test/api" },
  };
  const recorded: CapturedEvent[] = [];
  const asked: CapturedEvent[] = [];
  let networkDeps: NetworkCaptureDeps | undefined;
  let document: ReturnType<ChromeFake["connectFrom"]> | undefined;
  try {
    fake.storage.local.set("connection", {
      openbotUrl: "http://127.0.0.1:9",
      token: "obr_one",
      connectionId: "c-1",
      user: { id: "p1", name: "Ada", email: "ada@example.test" },
      via: "web",
      connectedAt: startedAt,
    });
    fake.storage.local.set("activeRecording", {
      recordingId,
      title: "Update deal",
      openbotUrl: "http://127.0.0.1:9",
      userId: "p1",
      userName: "Ada",
      trajectoryIds: [trajectoryId],
      startedAt,
    });
    fake.storage.session.set("recorder", {
      ...IDLE_STATE,
      phase: "recording",
      recordingId,
      title: "Update deal",
      tabIds: [7],
      topUrls: { "7": "https://crm.example.test/" },
      startedAt,
      actions: 1,
      capture: {
        intelligence: "streaming",
        network: "page",
      },
    });
    fake.storage.session.set("stream", {
      recordingId,
      title: "Update deal",
      openbotUrl: "http://127.0.0.1:9",
      token: "obr_one",
      trajectoryId,
      startedAt,
      allowedIntelligenceUrls: null,
      version: "0.3.0",
    } satisfies StreamSession);
    fake.offscreen.open = true;
    const handlers = installRecording({
      createNetworkCapture: (deps) => {
        networkDeps = deps;
        return {
          start: async () => "page",
          addTab: async () => {},
          onCommitted: async () => {},
          resume: async () => "page",
          action: () => {},
          recordPageEvent: async (_tabId, accepted) => {
            recorded.push(accepted);
          },
          recordPageAgent: () => {},
          stop: async () => {},
        };
      },
      createPageFallback: () => ({
        start: async () => false,
        addTab: async () => {},
        onCommitted: async () => {},
        stop: async () => {},
        active: () => false,
      }),
      acceptPageNetworkEvent: (received) => {
        asked.push(received);
        return received;
      },
      readPolicy: async () => ({
        openbotUrl: null,
        openbotUrlInvalid: false,
        allowedIntelligenceUrls: null,
      }),
      hasHostPermission: async () => true,
    });
    installRouter(handlers);
    document = fake.connectFrom(PORT_OFFSCREEN, {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL("offscreen.html"),
    });
    document.postMessage({ type: "offscreen.ready" });
    await recoverInterruptedRecording();
    expect(networkDeps).toBeDefined();

    const answer = await fake.sendExternal(
      { type: "recorder.page-network", event },
      {
        tab: { id: 7 } as chrome.tabs.Tab,
        url: "https://crm.example.test/",
        origin: "https://crm.example.test",
      },
    );
    expect(answer).toEqual({ ok: true });
    expect(asked).toEqual([event]);
    expect(recorded).toEqual([event]);
    expect(
      (document.messages as { type: string }[]).filter(
        (message) => message.type === "offscreen.event",
      ),
    ).toEqual([]);
  } finally {
    document?.disconnect();
  }
});
