import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createContentPort } from "../src/content/port";
import type {
  BackgroundToContent,
  ContentToBackground,
} from "../src/protocol/messages";

type TestPort = {
  port: chrome.runtime.Port;
  sent: ContentToBackground[];
  disconnect(): void;
  receive(message: BackgroundToContent): void;
  disconnected: boolean;
};

function makePort(): TestPort {
  const sent: ContentToBackground[] = [];
  const messageListeners: ((m: BackgroundToContent) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const state = { disconnected: false };
  const port = {
    postMessage: (m: ContentToBackground) => {
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

function harness(maxBuffer?: number) {
  const ports: TestPort[] = [];
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const content = createContentPort({
    connect: () => {
      const next = makePort();
      ports.push(next);
      return next.port;
    },
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
  return { content, ports, timeouts, fire };
}

const eventMessage = (n: number): ContentToBackground => ({
  type: "content.event",
  event: { type: "CUSTOM", name: "click", timestamp: 1000 + n, value: { n } },
});
const stepMessage = (n: number): ContentToBackground =>
  ({
    type: "content.step",
    action: { kind: "click", url: `https://example.test/${n}`, target: {} },
  }) as ContentToBackground;
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

    content.post(stepMessage(1));
    ports[0].receive({ type: "background.capture", active: true });

    expect(ports[0].sent).toEqual([stepMessage(1)]);
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

    content.post(stepMessage(1));
    content.post(eventMessage(1));
    content.post(digestMessage(1));
    fire();

    const sent = ports[1].sent;
    expect(sent[0]).toMatchObject({
      type: "content.hello",
      top: expect.any(Boolean),
    });
    expect(sent.slice(1)).toEqual([
      stepMessage(1),
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

  test("steps and digests among the events are all kept, in order, and never dropped", () => {
    const { content, ports, fire } = harness();
    ports[0].disconnect();

    const expected: unknown[] = [];
    for (let n = 0; n < 30; n += 1) {
      const step = stepMessage(n);
      content.post(step);
      expected.push(step);
    }
    for (let n = 0; n < 5; n += 1) {
      const digest = digestMessage(n);
      content.post(digest);
      expected.push(digest);
    }
    for (let n = 0; n < 250; n += 1) content.post(eventMessage(n));
    fire();

    const sent: ContentToBackground[] = ports[1].sent;
    expect(sent.filter((m) => m.type === "content.step") as unknown[]).toEqual(
      expected.slice(0, 30),
    );
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
        throw new Error("Extension context invalidated.");
      },
      timers: { set: (fn, ms) => timeouts.push({ fn, ms }), clear: () => {} },
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
});
