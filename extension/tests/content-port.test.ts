import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createContentPort } from "../src/content/port";
import type {
  BackgroundToContent,
  ContentToBackground,
} from "../src/protocol/messages";
import { parseContentMessage } from "../src/protocol/messages";
import { installChromeFake } from "./support/chrome-fake";

type TestPort = {
  port: chrome.runtime.Port;
  sent: ContentToBackground[];
  disconnect(): void;
  receive(message: BackgroundToContent): void;
  disconnected: boolean;
};

/** `failAfter`: the port dies after that many messages, before Chrome tells the script, so the next post throws as
 * Chrome's own does ("Attempting to use a disconnected port object"). */
function makePort(failAfter = Number.POSITIVE_INFINITY): TestPort {
  const sent: ContentToBackground[] = [];
  const messageListeners: ((m: BackgroundToContent) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const state = { disconnected: false };
  const port = {
    postMessage: (m: ContentToBackground) => {
      if (sent.length >= failAfter)
        throw new Error("Attempting to use a disconnected port object");
      sent.push(m);
    },
    disconnect: () => {
      state.disconnected = true;
    },
    onMessage: {
      addListener: (l: (m: BackgroundToContent) => void) =>
        messageListeners.push(l),
    },
    onDisconnect: {
      addListener: (l: () => void) => disconnectListeners.push(l),
    },
  } as unknown as chrome.runtime.Port;
  return {
    port,
    sent,
    get disconnected() {
      return state.disconnected;
    },
    disconnect: () => {
      for (const l of disconnectListeners) l();
    },
    receive: (m) => {
      for (const l of messageListeners) l(m);
    },
  };
}

function harness(
  maxBuffer?: number,
  options: { orphaned?: () => boolean } = {},
) {
  const ports: TestPort[] = [];
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  /** How many messages the next port takes before it dies; undefined for a port that stays up. */
  const control: { failAfter?: number } = {};
  const content = createContentPort({
    connect: () => {
      const next = makePort(control.failAfter);
      control.failAfter = undefined;
      ports.push(next);
      return next.port;
    },
    orphaned: options.orphaned ?? (() => false),
    timers: {
      set: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        timeouts.push(entry);
        return entry;
      },
      clear: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    maxBuffer,
  });
  const fire = () => {
    const entry = timeouts.filter((t) => !t.cleared).pop();
    if (!entry) throw new Error("no timer pending");
    entry.cleared = true;
    entry.fn();
  };
  const pending = () => timeouts.filter((t) => !t.cleared);
  return { content, ports, timeouts, fire, pending, control };
}

const eventMessage = (n: number): ContentToBackground => ({
  type: "content.event",
  event: { type: "CUSTOM", name: "click", timestamp: 1000 + n, value: { n } },
});
const noticeMessage = (n: number): ContentToBackground => ({
  type: "content.notice",
  choice: n % 2 === 0 ? "continue" : "stop",
});
const digestMessage = (n: number): ContentToBackground => ({
  type: "content.sensitive",
  digest: n.toString(16).padStart(64, "0"),
});

describe("createContentPort", () => {
  const globals = globalThis as Record<string, unknown>;
  const hadWindow = "window" in globalThis;
  const hadLocation = "location" in globalThis;
  const savedWindow = globals.window;
  const savedLocation = globals.location;
  beforeEach(() => {
    const frame: Record<string, unknown> = {};
    frame.top = frame;
    globals.window = frame;
    globals.location = { href: "https://example.test/page" };
  });
  afterEach(() => {
    if (hadWindow) globals.window = savedWindow;
    else delete globals.window;
    if (hadLocation) globals.location = savedLocation;
    else delete globals.location;
  });

  test("posts straight through while connected and hands incoming messages to listeners", () => {
    const { content, ports } = harness();
    const received: BackgroundToContent[] = [];
    content.onMessage((m) => received.push(m));

    content.post(noticeMessage(1));
    ports[0].receive({ type: "background.capture", active: true });

    expect(ports[0].sent).toEqual([noticeMessage(1)]);
    expect(received).toEqual([{ type: "background.capture", active: true }]);
  });

  test("reconnects after 0.5, 1, 2 and 4 s, then every 4 s", () => {
    const { ports, timeouts, fire } = harness();

    for (let i = 0; i < 6; i += 1) {
      ports[ports.length - 1].disconnect();
      fire();
    }

    expect(timeouts.map((t) => t.ms)).toEqual([
      500, 1000, 2000, 4000, 4000, 4000,
    ]);
    expect(ports).toHaveLength(7);
  });

  test("restarts the delays once the service worker has answered on a reconnected port", () => {
    const { ports, timeouts, fire } = harness();

    ports[0].disconnect();
    fire();
    ports[1].disconnect();
    fire();
    ports[2].receive({ type: "background.capture", active: true });
    ports[2].disconnect();

    expect(timeouts.map((t) => t.ms)).toEqual([500, 1000, 500]);
  });

  test("messages posted while disconnected arrive after content.hello, in order", () => {
    const { content, ports, fire } = harness();
    ports[0].disconnect();

    content.post(noticeMessage(1));
    content.post(eventMessage(1));
    content.post(digestMessage(1));
    fire();

    const sent = ports[1].sent;
    expect(sent[0]).toMatchObject({
      type: "content.hello",
      top: expect.any(Boolean),
    });
    expect(sent.slice(1)).toEqual([
      noticeMessage(1),
      eventMessage(1),
      digestMessage(1),
    ]);
  });

  test("with 205 events buffered the 5 oldest are dropped and counted before the 200 that remain", () => {
    const { content, ports, fire } = harness();
    ports[0].disconnect();

    for (let n = 0; n < 205; n += 1) content.post(eventMessage(n));
    fire();

    const sent = ports[1].sent;
    expect(sent).toHaveLength(1 + 1 + 200);
    expect(sent[0].type).toBe("content.hello");
    expect(sent[1]).toMatchObject({
      type: "content.event",
      event: {
        name: "recorder.dropped",
        value: { count: 5, reason: "content-port" },
      },
    });
    expect(sent[2]).toEqual(eventMessage(5));
    expect(sent[201]).toEqual(eventMessage(204));
  });

  test("notice choices and digests among the events are all kept, in order, and never dropped", () => {
    const { content, ports, fire } = harness();
    ports[0].disconnect();

    const expected: unknown[] = [];
    for (let n = 0; n < 30; n += 1) {
      const choice = noticeMessage(n);
      content.post(choice);
      expected.push(choice);
    }
    for (let n = 0; n < 5; n += 1) {
      const digest = digestMessage(n);
      content.post(digest);
      expected.push(digest);
    }
    for (let n = 0; n < 250; n += 1) content.post(eventMessage(n));
    fire();

    const sent: ContentToBackground[] = ports[1].sent;
    expect(
      sent.filter((m) => m.type === "content.notice") as unknown[],
    ).toEqual(expected.slice(0, 30));
    expect(
      sent.filter((m) => m.type === "content.sensitive") as unknown[],
    ).toEqual(expected.slice(30));
    expect(
      sent.filter(
        (m) => m.type === "content.event" && m.event.name === "click",
      ),
    ).toHaveLength(200);
    expect(
      sent.find(
        (m) =>
          m.type === "content.event" && m.event.name === "recorder.dropped",
      ),
    ).toMatchObject({ event: { value: { count: 50 } } });
  });

  test("a drop count is reported once, not again after the next reconnect", () => {
    const { content, ports, fire } = harness(2);
    ports[0].disconnect();
    for (let n = 0; n < 3; n += 1) content.post(eventMessage(n));
    fire();
    ports[1].disconnect();
    fire();

    expect(
      ports[2].sent.some(
        (m) =>
          m.type === "content.event" && m.event.name === "recorder.dropped",
      ),
    ).toBe(false);
  });

  test("a connect that throws is retried on the next delay", () => {
    let calls = 0;
    const timeouts: { fn: () => void; ms: number }[] = [];
    createContentPort({
      connect: () => {
        calls += 1;
        throw new Error("Could not establish connection.");
      },
      timers: { set: (fn, ms) => timeouts.push({ fn, ms }), clear: () => {} },
      orphaned: () => false,
    });

    timeouts[0].fn();

    expect(calls).toBe(2);
    expect(timeouts.map((t) => t.ms)).toEqual([500, 1000]);
  });

  test("dispose cancels the pending reconnect and disconnects the live port", () => {
    const { content, ports, timeouts } = harness();
    content.dispose();
    expect(ports[0].disconnected).toBe(true);

    const second = harness();
    second.ports[0].disconnect();
    second.content.dispose();
    expect(second.timeouts.every((t) => t.cleared)).toBe(true);
    expect(timeouts).toHaveLength(0);
  });

  test("a digest posted to a port that died before Chrome said so is kept, and sent after the one reconnect", () => {
    const { content, ports, fire } = harness();
    ports[0].port.postMessage = () => {
      throw new Error("Attempting to use a disconnected port object");
    };

    expect(() => content.post(digestMessage(1))).not.toThrow();
    content.post(eventMessage(1));
    ports[0].disconnect();
    fire();

    expect(ports).toHaveLength(2);
    expect(ports[1].sent.slice(1)).toEqual([digestMessage(1), eventMessage(1)]);
  });

  test("a port that dies during the flush keeps what it had not sent, in order, for the next one", () => {
    const { content, ports, fire, control } = harness();
    ports[0].disconnect();
    content.post(digestMessage(1));
    content.post(eventMessage(1));
    content.post(digestMessage(2));
    control.failAfter = 2;
    fire();
    fire();

    expect(ports[1].sent).toEqual([
      expect.objectContaining({ type: "content.hello" }),
      digestMessage(1),
    ]);
    expect(ports[2].sent.slice(1)).toEqual([eventMessage(1), digestMessage(2)]);
  });

  test("an orphaned script, its extension updated or removed, stops reconnecting and says so", () => {
    let orphaned = false;
    const { content, ports, pending } = harness(undefined, {
      orphaned: () => orphaned,
    });
    let told = 0;
    content.onOrphaned(() => {
      told += 1;
    });

    orphaned = true;
    ports[0].disconnect();
    content.post(digestMessage(1));

    expect(pending()).toEqual([]);
    expect(told).toBe(1);
    expect(ports).toHaveLength(1);
    // A listener added afterwards hears it at once.
    content.onOrphaned(() => {
      told += 1;
    });
    expect(told).toBe(2);
  });

  test("a connect refused because the extension context is gone is not retried", () => {
    const timeouts: unknown[] = [];
    let calls = 0;
    const content = createContentPort({
      connect: () => {
        calls += 1;
        throw new Error("Extension context invalidated.");
      },
      timers: { set: (fn, ms) => timeouts.push({ fn, ms }), clear: () => {} },
      orphaned: () => true,
    });
    let told = false;
    content.onOrphaned(() => {
      told = true;
    });

    expect(calls).toBe(1);
    expect(timeouts).toEqual([]);
    expect(told).toBe(true);
  });

  test("by default a script is orphaned once chrome.runtime.id is gone", () => {
    const fake = installChromeFake();
    try {
      const ports: TestPort[] = [];
      const timeouts: { fn: () => void }[] = [];
      createContentPort({
        connect: () => {
          const next = makePort();
          ports.push(next);
          return next.port;
        },
        timers: { set: (fn) => timeouts.push({ fn }), clear: () => {} },
      });
      ports[0]?.disconnect();
      expect(timeouts).toHaveLength(1);
      timeouts[0]?.fn();

      Object.defineProperty(chrome.runtime, "id", {
        value: undefined,
        configurable: true,
      });
      ports[1]?.disconnect();

      expect(timeouts).toHaveLength(1);
    } finally {
      fake.uninstall();
    }
  });

  test("clips a very long page address so the hello sent after a reconnect still parses", () => {
    globals.location = {
      href: `https://example.test/saml?SAMLRequest=${"a".repeat(5000)}`,
    };
    const { ports, fire } = harness();

    ports[0].disconnect();
    fire();

    const hello = ports[1].sent[0];
    expect(hello.type).toBe("content.hello");
    const parsed = parseContentMessage(hello);
    expect(parsed).not.toBeNull();
    expect(parsed?.type === "content.hello" && parsed.url.length).toBe(4096);
  });
});

describe("the content script entry", () => {
  const globals = globalThis as Record<string, unknown>;
  let uninstall: (() => void) | undefined;
  beforeEach(() => {
    GlobalRegistrator.register({ url: "https://app.example.test/page" });
  });
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    Reflect.deleteProperty(globals, "__openbotRecorderActive");
    Reflect.deleteProperty(globals, "__openbotRecorderContent");
    GlobalRegistrator.unregister();
  });

  test("a frame injected with the active flag captures before its port answers", async () => {
    const fake = installChromeFake();
    uninstall = () => fake.uninstall();
    const received: ContentToBackground[] = [];
    chrome.runtime.onConnect.addListener((port) => {
      // The service worker never answers: nothing but the frame's own flag can have started the capture.
      port.onMessage.addListener((m: ContentToBackground) => received.push(m));
    });
    globals.__openbotRecorderActive = "d1";
    document.body.innerHTML = `<button id="save">Save</button>`;

    await import("../src/content/index");
    const click = new MouseEvent("click", { bubbles: true, button: 0 });
    Object.defineProperty(click, "isTrusted", { value: true });
    document.getElementById("save")?.dispatchEvent(click);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received[0]).toMatchObject({ type: "content.hello", top: true });
    const captured = received.find(
      (m) => m.type === "content.event" && m.event.name === "click",
    );
    expect(captured).toMatchObject({
      type: "content.event",
      event: { name: "click", value: { target: { tag: "button" } } },
    });
    expect(globals.__openbotRecorderContent).toBe(true);
  });

  function trustedClick(el: Element | null | undefined) {
    const click = new MouseEvent("click", {
      bubbles: true,
      composed: true,
      button: 0,
    });
    Object.defineProperty(click, "isTrusted", { value: true });
    el?.dispatchEvent(click);
  }

  test("capture stopping takes the 50-action notice down", async () => {
    const fake = installChromeFake();
    uninstall = () => fake.uninstall();
    const ports: chrome.runtime.Port[] = [];
    const received: ContentToBackground[] = [];
    chrome.runtime.onConnect.addListener((port) => {
      ports.push(port);
      port.onMessage.addListener((m: ContentToBackground) => received.push(m));
    });
    await import(`../src/content/index?fresh=${Date.now()}0`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const port = ports[0];
    port.postMessage({ type: "background.notice", show: true, actions: 50 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const oldNotice = document.querySelector("openbot-recorder-notice");
    expect(oldNotice).not.toBeNull();

    port.postMessage({ type: "background.capture", active: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.querySelector("openbot-recorder-notice")).toBeNull();
    expect(oldNotice?.isConnected).toBe(false);
  });

  test("a click inside a part of the page marked to be ignored is not captured", async () => {
    const fake = installChromeFake();
    uninstall = () => fake.uninstall();
    const received: ContentToBackground[] = [];
    chrome.runtime.onConnect.addListener((port) => {
      port.onMessage.addListener((m: ContentToBackground) => received.push(m));
    });
    globals.__openbotRecorderActive = "d1";
    document.body.innerHTML = `<div data-copilotkit-ignore><button id="skip">Skip</button></div><button id="keep">Keep</button>`;
    await import(`../src/content/index?fresh=${Date.now()}1`);

    const clicks = () =>
      received.filter(
        (m) => m.type === "content.event" && m.event.name === "click",
      );
    trustedClick(document.getElementById("skip"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clicks()).toEqual([]);

    trustedClick(document.getElementById("keep"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clicks()).toMatchObject([
      { event: { value: { target: { text: "Keep" } } } },
    ]);
  });
  test("a script orphaned by an extension update stops capturing", async () => {
    const fake = installChromeFake();
    uninstall = () => fake.uninstall();
    const ports: chrome.runtime.Port[] = [];
    chrome.runtime.onConnect.addListener((port) => {
      ports.push(port);
    });
    globals.__openbotRecorderActive = "d1";
    document.body.innerHTML = `<button id="save">Save</button>`;
    let listening = 0;
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((...args: Parameters<typeof add>) => {
      if (args[0] === "click") listening += 1;
      add(...args);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((...args: Parameters<typeof remove>) => {
      if (args[0] === "click") listening -= 1;
      remove(...args);
    }) as typeof window.removeEventListener;
    try {
      await import(`../src/content/index?fresh=${Date.now()}2`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ports).toHaveLength(1);
      expect(listening).toBeGreaterThan(0);

      Object.defineProperty(chrome.runtime, "id", {
        value: undefined,
        configurable: true,
      });
      ports[0]?.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(listening).toBe(0);
    } finally {
      window.addEventListener = add;
      window.removeEventListener = remove;
    }
  });
});
