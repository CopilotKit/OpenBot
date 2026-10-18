/**
 * An in-memory `chrome` for the Recorder's tests. It implements exactly the APIs the extension calls and
 * exposes drivers and recorders on the returned `ChromeFake`. Install it per test and uninstall it after.
 * IndexedDB is not part of it: tests import `fake-indexeddb/auto`.
 */

import { isDeepStrictEqual } from "node:util";

type Listener = (...args: unknown[]) => unknown;
type Json = Record<string, unknown>;

export type FakePort = {
  postMessage(message: unknown): void;
  messages: unknown[];
  disconnect(): void;
  onDisconnect: { called: boolean };
};

export type ChromeFake = {
  uninstall(): void;
  /**
   * Every chrome.* call and every port message in either direction, in order: "tabCapture.getMediaStreamId",
   * "offscreen.createDocument", "runtime.onMessage.addListener", "port:recorder:offscreen offscreen.start".
   */
  calls: string[];
  storage: {
    local: Map<string, unknown>;
    session: Map<string, unknown>;
    managed: Map<string, unknown>;
    accessLevel: string | null;
    sessionAccessLevel: string | null;
    setManaged(values: Record<string, unknown>): void;
  };
  /** Simulates a port opened by another context; returns the far end. */
  connectFrom(name: string, sender: chrome.runtime.MessageSender): FakePort;
  sendExternal(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown>;
  sendFromPage(
    message: unknown,
    sender?: Partial<chrome.runtime.MessageSender>,
  ): Promise<unknown>;
  permissions: {
    granted: Set<string>;
    requests: chrome.permissions.Permissions[];
    answer: boolean;
  };
  scripting: {
    registered: chrome.scripting.RegisteredContentScript[];
    executed: chrome.scripting.ScriptInjection<unknown[], unknown>[];
    refuseFrames?: number[];
  };
  offscreen: {
    /** Whether the document exists: true from createDocument until closeDocument, across restartServiceWorker. */
    open: boolean;
    created: chrome.offscreen.CreateParameters[];
    /**
     * Test hooks, not part of chrome.offscreen: they run when createDocument opened a document or closeDocument closed
     * it, with `open` already updated and before the call resolves, so a test can play the document's own side (its
     * port connecting, then going down). Like the document, they survive restartServiceWorker.
     */
    onDocumentCreated: FakeHook<
      [parameters: chrome.offscreen.CreateParameters]
    >;
    onDocumentClosed: FakeHook<[]>;
  };
  tabCapture: { calls: { targetTabId?: number }[]; answer: string | Error };
  debugger: {
    attached: chrome.debugger.Debuggee[];
    commands: {
      target: chrome.debugger.Debuggee;
      method: string;
      params?: object;
    }[];
    respond(
      method: string,
      result: object | ((params: object) => object),
    ): void;
    emit(
      target: chrome.debugger.Debuggee,
      method: string,
      params: object,
    ): void;
    detach(
      target: chrome.debugger.Debuggee,
      reason: "target_closed" | "canceled_by_user",
    ): void;
    refuseAttach?: string;
    targets(): chrome.debugger.TargetInfo[];
  };
  webNavigation: {
    commit(
      details: Partial<chrome.webNavigation.WebNavigationTransitionCallbackDetails>,
    ): void;
    historyUpdate(
      details: Partial<chrome.webNavigation.WebNavigationTransitionCallbackDetails>,
    ): void;
    createdTarget(details: {
      sourceTabId: number;
      tabId: number;
      url: string;
    }): void;
  };
  native: { reply: ((message: object) => object) | null; sent: object[] };
  badge: { text: string; color: string };
  alarms: {
    created: Map<string, chrome.alarms.AlarmCreateInfo>;
    fire(name: string): void;
  };
  tabs: Map<number, chrome.tabs.Tab>;
  opened: string[];
  updated: { tabId: number; props: chrome.tabs.UpdateProperties }[];
  /** The tab ids chrome.tabs.remove closed, in order. */
  removed: number[];
  /**
   * Simulates the service worker being torn down and started again: its listeners and the ports other contexts
   * hold to it are gone (the test re-registers them), while storage.session, storage.local, tabs, the offscreen
   * document, alarms and attached debuggers stay. onStartup and onInstalled run only when asked.
   */
  restartServiceWorker(): void;
  fireStartup(): void;
  fireInstalled(reason: string): void;
};

const DEFAULT_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

type FakeHook<Args extends unknown[]> = {
  addListener(listener: (...args: Args) => void): void;
  removeListener(listener: (...args: Args) => void): void;
};

/** A test-side hook: unlike a chrome event it is typed, unrecorded in `calls`, and kept across restartServiceWorker. */
function createHook<Args extends unknown[]>(): FakeHook<Args> & {
  dispatch(...args: Args): void;
} {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    dispatch: (...args) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

type FakeEvent = {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
  hasListener(listener: Listener): boolean;
  hasListeners(): boolean;
  dispatch(...args: unknown[]): unknown[];
  clear(): void;
};

function createEvent(name: string | null, calls: string[]): FakeEvent {
  const listeners = new Set<Listener>();
  return {
    addListener(listener) {
      if (name) calls.push(`${name}.addListener`);
      listeners.add(listener);
    },
    removeListener(listener) {
      if (name) calls.push(`${name}.removeListener`);
      listeners.delete(listener);
    },
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    dispatch: (...args) => [...listeners].map((listener) => listener(...args)),
    clear: () => listeners.clear(),
  };
}

/** Chrome's message passing serializes as JSON: Sets, Maps and functions do not survive, and the sender cannot mutate the copy. */
function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/**
 * Runs onMessage-style listeners in a microtask, as Chrome does, handing them a JSON copy of the message, and
 * resolves with the first response (also a JSON copy), or undefined when none answers.
 */
function deliver(
  event: FakeEvent,
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      let answered = false;
      const sendResponse = (response: unknown) => {
        if (answered) return;
        answered = true;
        resolve(jsonCopy(response));
      };
      const results = event.dispatch(jsonCopy(message), sender, sendResponse);
      if (!answered && !results.includes(true)) resolve(undefined);
    });
  });
}

function messageType(message: unknown): string {
  if (typeof message === "object" && message !== null && "type" in message)
    return String((message as Json).type);
  return "message";
}

type PortEnd = {
  name: string;
  sender?: chrome.runtime.MessageSender;
  messages: unknown[];
  onMessage: FakeEvent;
  onDisconnect: FakeEvent;
  disconnected: boolean;
  disconnectFired: boolean;
  postMessage(message: unknown): void;
  disconnect(): void;
};

function createPortPair(
  name: string,
  sender: chrome.runtime.MessageSender,
  calls: string[],
) {
  const makeEnd = (): PortEnd => ({
    name,
    messages: [],
    onMessage: createEvent(null, calls),
    onDisconnect: createEvent(null, calls),
    disconnected: false,
    disconnectFired: false,
    postMessage() {},
    disconnect() {},
  });
  const near = makeEnd();
  const far = makeEnd();
  near.sender = sender;
  const wire = (from: PortEnd, to: PortEnd) => {
    from.postMessage = (message) => {
      if (from.disconnected)
        throw new Error("Attempting to use a disconnected port object");
      calls.push(`port:${name} ${messageType(message)}`);
      const copy = jsonCopy(message);
      queueMicrotask(() => {
        to.messages.push(copy);
        to.onMessage.dispatch(copy, to);
      });
    };
    from.disconnect = () => {
      if (from.disconnected) return;
      from.disconnected = true;
      queueMicrotask(() => {
        to.disconnected = true;
        to.disconnectFired = true;
        to.onDisconnect.dispatch(to);
      });
    };
  };
  wire(near, far);
  wire(far, near);
  return { near, far };
}

function matches(value: unknown, wanted: unknown): boolean {
  return wanted === undefined || value === wanted;
}

export function installChromeFake(
  options: { extensionId?: string; manifestVersion?: string } = {},
): ChromeFake {
  const extensionId = options.extensionId ?? DEFAULT_EXTENSION_ID;
  const manifestVersion = options.manifestVersion ?? "0.0.0";
  const calls: string[] = [];
  const events: FakeEvent[] = [];
  const event = (name: string): FakeEvent => {
    const created = createEvent(name, calls);
    events.push(created);
    return created;
  };

  const runtimeEvents = {
    onMessage: event("runtime.onMessage"),
    onMessageExternal: event("runtime.onMessageExternal"),
    onConnect: event("runtime.onConnect"),
    onInstalled: event("runtime.onInstalled"),
    onStartup: event("runtime.onStartup"),
  };
  const serviceWorkerPorts: PortEnd[] = [];
  const notifyStorage: Partial<
    Record<
      "local" | "session" | "managed",
      (changes: Record<string, chrome.storage.StorageChange>) => void
    >
  > = {};

  const extensionPageSender = (): chrome.runtime.MessageSender => ({
    id: extensionId,
    url: `chrome-extension://${extensionId}/popup.html`,
    origin: `chrome-extension://${extensionId}`,
  });

  const openPort = (name: string, sender: chrome.runtime.MessageSender) => {
    const pair = createPortPair(name, sender, calls);
    if (!runtimeEvents.onConnect.hasListeners()) {
      // Nobody is listening for connections: Chrome disconnects the connecting end.
      queueMicrotask(() => {
        pair.near.disconnected = true;
        pair.far.disconnected = true;
        pair.far.disconnectFired = true;
        pair.far.onDisconnect.dispatch(pair.far);
      });
      return pair;
    }
    serviceWorkerPorts.push(pair.near);
    runtimeEvents.onConnect.dispatch(pair.near);
    return pair;
  };

  const documentCreated =
    createHook<[parameters: chrome.offscreen.CreateParameters]>();
  const documentClosed = createHook<[]>();

  const fake: ChromeFake = {
    uninstall() {
      Reflect.deleteProperty(globalThis, "chrome");
    },
    calls,
    storage: {
      local: new Map(),
      session: new Map(),
      managed: new Map(),
      accessLevel: null,
      sessionAccessLevel: null,
      setManaged(values) {
        const managed = fake.storage.managed;
        const before = new Map(managed);
        managed.clear();
        for (const [key, value] of Object.entries(values))
          managed.set(key, jsonCopy(value));
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, value] of managed)
          if (!before.has(key) || !isDeepStrictEqual(before.get(key), value))
            changes[key] = { oldValue: before.get(key), newValue: value };
        for (const [key, oldValue] of before)
          if (!managed.has(key)) changes[key] = { oldValue };
        notifyStorage.managed?.(changes);
      },
    },
    connectFrom(name, sender) {
      const { far } = openPort(name, sender);
      return {
        postMessage: far.postMessage,
        messages: far.messages,
        disconnect: far.disconnect,
        onDisconnect: {
          get called() {
            return far.disconnectFired;
          },
        },
      };
    },
    sendExternal: (message, sender) =>
      deliver(runtimeEvents.onMessageExternal, message, sender),
    sendFromPage: (message, sender) => sendMessageFrom(message, sender),
    permissions: { granted: new Set(), requests: [], answer: true },
    scripting: { registered: [], executed: [] },
    offscreen: {
      open: false,
      created: [],
      onDocumentCreated: documentCreated,
      onDocumentClosed: documentClosed,
    },
    tabCapture: { calls: [], answer: "stream-id" },
    debugger: {
      attached: [],
      commands: [],
      respond(method, result) {
        responders.set(method, result);
      },
      emit(target, method, params) {
        debuggerEvents.onEvent.dispatch(target, method, params);
      },
      detach(target, reason) {
        removeAttached(target);
        debuggerEvents.onDetach.dispatch(target, reason);
      },
      targets: () =>
        [...fake.tabs.values()].map((tab) => {
          const attached = fake.debugger.attached.some(
            (debuggee) => debuggee.tabId === tab.id,
          );
          return {
            id: `target-${tab.id}`,
            type: "page",
            title: tab.title ?? "",
            url: tab.url ?? "",
            attached,
            tabId: tab.id,
            ...(attached ? { extensionId } : {}),
          } as chrome.debugger.TargetInfo;
        }),
    },
    webNavigation: {
      commit: (details) =>
        webNavigationEvents.onCommitted.dispatch(navigationDetails(details)),
      historyUpdate: (details) =>
        webNavigationEvents.onHistoryStateUpdated.dispatch(
          navigationDetails(details),
        ),
      createdTarget: (details) =>
        webNavigationEvents.onCreatedNavigationTarget.dispatch({
          sourceFrameId: 0,
          timeStamp: Date.now(),
          ...details,
        }),
    },
    native: { reply: null, sent: [] },
    badge: { text: "", color: "" },
    alarms: {
      created: new Map(),
      fire(name) {
        alarmEvents.onAlarm.dispatch({ name, scheduledTime: Date.now() });
      },
    },
    tabs: new Map(),
    opened: [],
    updated: [],
    removed: [],
    restartServiceWorker() {
      calls.push("serviceWorker.restart");
      for (const created of events) created.clear();
      for (const port of serviceWorkerPorts.splice(0)) port.disconnect();
    },
    fireStartup() {
      runtimeEvents.onStartup.dispatch();
    },
    fireInstalled(reason) {
      runtimeEvents.onInstalled.dispatch({ reason });
    },
  };

  const responders = new Map<string, object | ((params: object) => object)>();
  const debuggerEvents = {
    onEvent: event("debugger.onEvent"),
    onDetach: event("debugger.onDetach"),
  };
  const webNavigationEvents = {
    onCommitted: event("webNavigation.onCommitted"),
    onHistoryStateUpdated: event("webNavigation.onHistoryStateUpdated"),
    onCreatedNavigationTarget: event("webNavigation.onCreatedNavigationTarget"),
  };
  const alarmEvents = { onAlarm: event("alarms.onAlarm") };
  const tabEvents = { onRemoved: event("tabs.onRemoved") };
  const storageChanged = event("storage.onChanged");
  let nextTabId = 1000;

  const navigationDetails = (
    details: Partial<chrome.webNavigation.WebNavigationTransitionCallbackDetails>,
  ) => ({
    tabId: 1,
    frameId: 0,
    parentFrameId: -1,
    url: "about:blank",
    processId: 0,
    timeStamp: Date.now(),
    transitionType: "link",
    transitionQualifiers: [],
    ...details,
  });

  const removeAttached = (target: chrome.debugger.Debuggee) => {
    const index = fake.debugger.attached.findIndex(
      (debuggee) => debuggee.tabId === target.tabId,
    );
    if (index >= 0) fake.debugger.attached.splice(index, 1);
  };

  const storageArea = (areaName: "local" | "session" | "managed") => {
    const map = fake.storage[areaName];
    const changed = event(`storage.${areaName}.onChanged`);
    const notify = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(changes).length === 0) return;
      changed.dispatch(changes);
      storageChanged.dispatch(changes, areaName);
    };
    notifyStorage[areaName] = notify;
    const area: Record<string, unknown> = {
      async get(keys?: string | string[] | Json | null) {
        calls.push(`storage.${areaName}.get`);
        const result: Json = {};
        if (keys === null || keys === undefined) {
          for (const [key, value] of map) result[key] = structuredClone(value);
        } else if (typeof keys === "string" || Array.isArray(keys)) {
          for (const key of typeof keys === "string" ? [keys] : keys)
            if (map.has(key)) result[key] = structuredClone(map.get(key));
        } else {
          for (const [key, fallback] of Object.entries(keys))
            result[key] = structuredClone(
              map.has(key) ? map.get(key) : fallback,
            );
        }
        return result;
      },
      onChanged: changed,
    };
    if (areaName !== "managed") {
      area.set = async (items: Json) => {
        calls.push(`storage.${areaName}.set`);
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, value] of Object.entries(items)) {
          const next = jsonCopy(value);
          if (map.has(key) && isDeepStrictEqual(map.get(key), next)) continue;
          changes[key] = map.has(key)
            ? { oldValue: map.get(key), newValue: next }
            : { newValue: next };
          map.set(key, next);
        }
        notify(changes);
      };
      area.remove = async (keys: string | string[]) => {
        calls.push(`storage.${areaName}.remove`);
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const key of typeof keys === "string" ? [keys] : keys) {
          if (!map.has(key)) continue;
          changes[key] = { oldValue: map.get(key) };
          map.delete(key);
        }
        notify(changes);
      };
    }
    if (areaName === "local" || areaName === "session") {
      area.setAccessLevel = async (access: { accessLevel: string }) => {
        calls.push(`storage.${areaName}.setAccessLevel`);
        if (areaName === "local") fake.storage.accessLevel = access.accessLevel;
        else fake.storage.sessionAccessLevel = access.accessLevel;
      };
    }
    return area;
  };

  const originGranted = (origin: string) =>
    fake.permissions.granted.has(origin) ||
    fake.permissions.granted.has("<all_urls>");

  /** Test-only path: delivers as an extension page unless the sender is overridden. Never part of chrome.runtime. */
  const sendMessageFrom = async (
    message: unknown,
    senderOverride?: Partial<chrome.runtime.MessageSender>,
  ): Promise<unknown> => {
    calls.push("runtime.sendMessage");
    if (!runtimeEvents.onMessage.hasListeners())
      throw new Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    return deliver(runtimeEvents.onMessage, message, {
      ...extensionPageSender(),
      ...senderOverride,
    });
  };

  const chromeApi = {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      id: extensionId,
      getURL: (path: string) => {
        calls.push("runtime.getURL");
        return `chrome-extension://${extensionId}/${path.replace(/^\//, "")}`;
      },
      getManifest: () => {
        calls.push("runtime.getManifest");
        return {
          manifest_version: 3,
          name: "OpenBot Recorder",
          version: manifestVersion,
        };
      },
      async getContexts(filter: { contextTypes?: string[] } = {}) {
        calls.push("runtime.getContexts");
        const open =
          fake.offscreen.open &&
          (!filter.contextTypes ||
            filter.contextTypes.includes("OFFSCREEN_DOCUMENT"));
        return open
          ? [
              {
                contextType: "OFFSCREEN_DOCUMENT",
                contextId: "offscreen",
                tabId: -1,
                windowId: -1,
                frameId: -1,
                incognito: false,
              },
            ]
          : [];
      },
      sendMessage(
        message: unknown,
        optionsOrCallback?: unknown,
        maybeCallback?: unknown,
      ) {
        const callback = [optionsOrCallback, maybeCallback].find(
          (arg): arg is (response?: unknown) => void =>
            typeof arg === "function",
        );
        const result = sendMessageFrom(message);
        if (!callback) return result;
        result.then(
          (response) => callback(response),
          (error: Error) => {
            chromeApi.runtime.lastError = { message: error.message };
            try {
              callback();
            } finally {
              chromeApi.runtime.lastError = undefined;
            }
          },
        );
      },
      async sendNativeMessage(_host: string, message: object) {
        calls.push("runtime.sendNativeMessage");
        fake.native.sent.push(message);
        if (!fake.native.reply)
          throw new Error("Specified native messaging host not found.");
        return fake.native.reply(message);
      },
      connect(info: { name?: string } = {}) {
        calls.push("runtime.connect");
        return openPort(info.name ?? "", extensionPageSender()).far;
      },
      ...runtimeEvents,
    },
    storage: {
      local: storageArea("local"),
      session: storageArea("session"),
      managed: storageArea("managed"),
      onChanged: storageChanged,
    },
    permissions: {
      async request(permissions: chrome.permissions.Permissions) {
        calls.push("permissions.request");
        fake.permissions.requests.push(permissions);
        if (fake.permissions.answer) {
          for (const name of permissions.permissions ?? [])
            fake.permissions.granted.add(name);
          for (const origin of permissions.origins ?? [])
            fake.permissions.granted.add(origin);
        }
        return fake.permissions.answer;
      },
      async contains(permissions: chrome.permissions.Permissions) {
        calls.push("permissions.contains");
        return (
          (permissions.permissions ?? []).every((name) =>
            fake.permissions.granted.has(name),
          ) && (permissions.origins ?? []).every(originGranted)
        );
      },
    },
    scripting: {
      async executeScript(
        injection: chrome.scripting.ScriptInjection<unknown[], unknown>,
      ) {
        calls.push("scripting.executeScript");
        fake.scripting.executed.push(injection);
        const refused = fake.scripting.refuseFrames;
        if (
          refused &&
          injection.target.frameIds?.some((id) => refused.includes(id))
        )
          throw new Error("Cannot access contents of the frame");
        return [];
      },
      async registerContentScripts(
        scripts: chrome.scripting.RegisteredContentScript[],
      ) {
        calls.push("scripting.registerContentScripts");
        for (const script of scripts) {
          if (
            fake.scripting.registered.some(
              (existing) => existing.id === script.id,
            )
          )
            throw new Error(`Duplicate script ID '${script.id}'`);
          fake.scripting.registered.push(script);
        }
      },
      async unregisterContentScripts(filter: { ids?: string[] } = {}) {
        calls.push("scripting.unregisterContentScripts");
        fake.scripting.registered = fake.scripting.registered.filter(
          (script) =>
            filter.ids !== undefined && !filter.ids.includes(script.id),
        );
      },
    },
    // Chrome's errors, word for word: OffscreenCreateDocumentFunction::Run and OffscreenCloseDocumentFunction::Run in
    // Chromium's extensions/browser/api/offscreen/offscreen_api.cc.
    offscreen: {
      async createDocument(parameters: chrome.offscreen.CreateParameters) {
        calls.push("offscreen.createDocument");
        if (fake.offscreen.open)
          throw new Error("Only a single offscreen document may be created.");
        fake.offscreen.open = true;
        fake.offscreen.created.push(parameters);
        documentCreated.dispatch(parameters);
      },
      async closeDocument() {
        calls.push("offscreen.closeDocument");
        if (!fake.offscreen.open)
          throw new Error("No current offscreen document.");
        fake.offscreen.open = false;
        documentClosed.dispatch();
      },
      async hasDocument() {
        calls.push("offscreen.hasDocument");
        return fake.offscreen.open;
      },
    },
    tabCapture: {
      async getMediaStreamId(options: { targetTabId?: number } = {}) {
        calls.push("tabCapture.getMediaStreamId");
        fake.tabCapture.calls.push(options);
        if (fake.tabCapture.answer instanceof Error)
          throw fake.tabCapture.answer;
        return fake.tabCapture.answer;
      },
    },
    debugger: {
      async attach(target: chrome.debugger.Debuggee, _version: string) {
        calls.push("debugger.attach");
        if (fake.debugger.refuseAttach)
          throw new Error(fake.debugger.refuseAttach);
        if (
          fake.debugger.attached.some(
            (debuggee) => debuggee.tabId === target.tabId,
          )
        )
          throw new Error(
            "Another debugger is already attached to the tab with id: " +
              target.tabId,
          );
        fake.debugger.attached.push(target);
      },
      async detach(target: chrome.debugger.Debuggee) {
        calls.push("debugger.detach");
        removeAttached(target);
      },
      async sendCommand(
        target: chrome.debugger.Debuggee,
        method: string,
        params?: object,
      ) {
        calls.push("debugger.sendCommand");
        if (
          !fake.debugger.attached.some(
            (debuggee) => debuggee.tabId === target.tabId,
          )
        )
          throw new Error(
            `Debugger is not attached to the tab with id: ${target.tabId}`,
          );
        fake.debugger.commands.push({ target, method, params });
        const responder = responders.get(method);
        return typeof responder === "function"
          ? responder(params ?? {})
          : (responder ?? {});
      },
      async getTargets() {
        calls.push("debugger.getTargets");
        return fake.debugger.targets();
      },
      ...debuggerEvents,
    },
    webNavigation: webNavigationEvents,
    tabs: {
      async get(tabId: number) {
        calls.push("tabs.get");
        const tab = fake.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return tab;
      },
      async query(query: chrome.tabs.QueryInfo = {}) {
        calls.push("tabs.query");
        return [...fake.tabs.values()].filter(
          (tab) =>
            matches(tab.active, query.active) &&
            matches(tab.windowId, query.windowId) &&
            (typeof query.url !== "string" || tab.url === query.url),
        );
      },
      async create(props: chrome.tabs.CreateProperties) {
        calls.push("tabs.create");
        if (props.url) fake.opened.push(props.url);
        const tab = {
          id: nextTabId++,
          index: fake.tabs.size,
          windowId: 1,
          active: props.active ?? true,
          url: props.url,
          pinned: false,
          highlighted: false,
          incognito: false,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
        } as chrome.tabs.Tab;
        fake.tabs.set(tab.id as number, tab);
        return tab;
      },
      async update(tabId: number, props: chrome.tabs.UpdateProperties) {
        calls.push("tabs.update");
        const tab = fake.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        fake.updated.push({ tabId, props });
        if (props.active !== undefined) tab.active = props.active;
        if (props.url !== undefined) tab.url = props.url;
        return tab;
      },
      /** As Chrome does: closes each id in turn and rejects at the first unknown one, leaving the earlier ones closed. */
      async remove(tabIds: number | number[]) {
        calls.push("tabs.remove");
        for (const tabId of typeof tabIds === "number" ? [tabIds] : tabIds) {
          const tab = fake.tabs.get(tabId);
          if (!tab) throw new Error(`No tab with id: ${tabId}.`);
          fake.tabs.delete(tabId);
          fake.removed.push(tabId);
          tabEvents.onRemoved.dispatch(tabId, {
            windowId: tab.windowId,
            isWindowClosing: false,
          });
        }
      },
      ...tabEvents,
    },
    action: {
      async setBadgeText(details: { text: string }) {
        calls.push("action.setBadgeText");
        fake.badge.text = details.text;
      },
      async setBadgeBackgroundColor(details: {
        color: string | [number, number, number, number];
      }) {
        calls.push("action.setBadgeBackgroundColor");
        fake.badge.color = String(details.color);
      },
    },
    alarms: {
      async create(
        nameOrInfo: string | chrome.alarms.AlarmCreateInfo,
        info?: chrome.alarms.AlarmCreateInfo,
      ) {
        calls.push("alarms.create");
        if (typeof nameOrInfo === "string")
          fake.alarms.created.set(
            nameOrInfo,
            info ?? ({} as chrome.alarms.AlarmCreateInfo),
          );
        else fake.alarms.created.set("", nameOrInfo);
      },
      async get(name = "") {
        calls.push("alarms.get");
        return fake.alarms.created.has(name)
          ? { name, scheduledTime: Date.now() }
          : undefined;
      },
      async clear(name = "") {
        calls.push("alarms.clear");
        return fake.alarms.created.delete(name);
      },
      ...alarmEvents,
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeApi;
  return fake;
}
