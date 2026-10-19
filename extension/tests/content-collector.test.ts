import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  collectorBeforeSend,
  startEventCapture,
} from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

type Timer = { fn: () => void; at: number };
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, Timer>();
  return {
    set(fn: () => void, ms: number) {
      const id = next++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clear(handle: unknown) {
      pending.delete(handle as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const tracked: Array<() => void> = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const off of tracked.splice(0)) off();
  document.body.innerHTML = "";
});

function newTracker() {
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  tracked.push(tracker.install());
  return tracker;
}

/** happy-dom cannot make trusted events; a real collector listens for them, so this one is marked trusted by hand. */
function trustedEvent<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

describe("collectorBeforeSend", () => {
  test("an oversized event is trimmed inside beforeSend, before the collector's 16 KiB check", () => {
    const beforeSend = collectorBeforeSend(
      createSensitivityTracker(),
      () => {},
    );
    const out = beforeSend({
      type: "CUSTOM",
      name: "input",
      timestamp: 1,
      value: { target: { tag: "textarea", value: "x".repeat(40_000) } },
    } as never);
    expect(
      new TextEncoder().encode(JSON.stringify(out)).byteLength,
    ).toBeLessThanOrEqual(15 * 1024);
  });

  test("a value with a NUL character reaches send with U+FFFD, so the collector never refuses it", () => {
    const beforeSend = collectorBeforeSend(
      createSensitivityTracker(),
      () => {},
    );
    const out = beforeSend({
      type: "CUSTOM",
      name: "input",
      timestamp: 1,
      value: { target: { tag: "input", value: "a\u0000b" } },
    } as never);
    expect(JSON.stringify(out)).toContain("a\\uFFFDb".replace("\\uFFFD", "�"));
    expect(JSON.stringify(out)).not.toContain("\\u0000");
  });

  test("a beforeSend given an event maskCollectorEvent cannot read returns null and counts it", () => {
    const dropped: string[] = [];
    const beforeSend = collectorBeforeSend(
      createSensitivityTracker(),
      () => {},
      (reason) => dropped.push(reason),
    );
    expect(beforeSend(null as never)).toBeNull();
    expect(dropped).toEqual(["unreadable"]);
  });

  test("a page event from a sub-frame is dropped", () => {
    const top = Object.getOwnPropertyDescriptor(window, "top");
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    try {
      const emitted: CapturedEvent[] = [];
      const beforeSend = collectorBeforeSend(createSensitivityTracker(), (e) =>
        emitted.push(e),
      );
      const page = {
        type: "CUSTOM",
        name: "page",
        timestamp: 1,
        value: { url: "https://ad.test/", title: "" },
      };
      expect(beforeSend(page as never)).toBeNull();
      expect(emitted).toEqual([]);
    } finally {
      if (top) Object.defineProperty(window, "top", top);
      else delete (window as unknown as { top?: unknown }).top;
    }
  });

  test("a title-less top-frame page event waits for the title", () => {
    let state: DocumentReadyState = "loading";
    Object.defineProperty(document, "readyState", {
      get: () => state,
      configurable: true,
    });
    try {
      const emitted: CapturedEvent[] = [];
      const beforeSend = collectorBeforeSend(createSensitivityTracker(), (e) =>
        emitted.push(e),
      );
      const page = {
        type: "CUSTOM",
        name: "page",
        timestamp: 1,
        value: { url: "https://example.test/", title: "" },
      };
      expect(beforeSend(page as never)).toBeNull();
      document.title = "Orders";
      state = "interactive";
      document.dispatchEvent(new Event("DOMContentLoaded"));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.value).toMatchObject({
        url: "https://example.test/",
        title: "Orders",
      });
    } finally {
      delete (document as unknown as { readyState?: unknown }).readyState;
      document.title = "";
    }
  });

  test("a page event once the document has loaded passes through", () => {
    const beforeSend = collectorBeforeSend(
      createSensitivityTracker(),
      () => {},
    );
    const page = {
      type: "CUSTOM",
      name: "page",
      timestamp: 1,
      value: { url: "https://example.test/", title: "Home" },
    };
    expect(beforeSend(page as never)).toMatchObject({
      name: "page",
      value: { title: "Home" },
    });
  });
});

describe("startEventCapture coalescing", () => {
  function drive(options?: { send?: (event: CapturedEvent) => void }) {
    const timers = fakeTimers();
    const sent: CapturedEvent[] = [];
    const tracker = newTracker();
    const capture = startEventCapture({
      tracker,
      send: options?.send ?? ((event) => sent.push(event)),
      timers,
    });
    stops.push(capture.stop);
    return { timers, sent, capture };
  }

  test("keystrokes in one field become one input event after a pause", () => {
    document.body.innerHTML = `<input id="f1" name="f1">`;
    const { timers, sent } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    for (const value of ["h", "he", "hel", "hell", "hello"]) {
      field.value = value;
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
      timers.advance(20);
    }
    const typed = () => sent.filter((event) => event.name === "input");
    expect(typed()).toHaveLength(0);
    timers.advance(750);
    expect(typed()).toHaveLength(1);
    expect(JSON.stringify(typed()[0])).toContain("hello");
  });

  test("a click flushes a pending input first so order is kept", () => {
    document.body.innerHTML = `<input id="f1" name="f1"><button id="b">Save</button>`;
    const { sent } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    field.value = "abc";
    field.dispatchEvent(
      trustedEvent(new Event("input", { bubbles: true, composed: true })),
    );
    (document.getElementById("b") as HTMLElement).dispatchEvent(
      trustedEvent(
        new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
      ),
    );
    expect(
      sent.map((event) => event.name).filter((name) => name !== "page"),
    ).toEqual(["input", "click"]);
  });

  test("a change event flushes its field at once", () => {
    document.body.innerHTML = `<input id="f1" name="f1">`;
    const { sent } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    field.value = "abc";
    field.dispatchEvent(
      trustedEvent(new Event("input", { bubbles: true, composed: true })),
    );
    field.dispatchEvent(
      trustedEvent(new Event("change", { bubbles: true, composed: true })),
    );
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(1);
    expect(typed[0]?.value).toMatchObject({ eventType: "change" });
  });

  test("two fields coalesce separately", () => {
    document.body.innerHTML = `<input id="f1" name="f1"><input id="f2" name="f2">`;
    const { timers, sent } = drive();
    for (const id of ["f1", "f2", "f1", "f2"]) {
      const field = document.getElementById(id) as HTMLInputElement;
      field.value += "x";
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
    }
    timers.advance(750);
    expect(sent.filter((event) => event.name === "input")).toHaveLength(2);
  });

  test("stop flushes a pending input", () => {
    document.body.innerHTML = `<input id="f1" name="f1">`;
    const { sent, capture } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    field.value = "abc";
    field.dispatchEvent(
      trustedEvent(new Event("input", { bubbles: true, composed: true })),
    );
    capture.stop();
    expect(sent.filter((event) => event.name === "input")).toHaveLength(1);
  });

  test("a value with a NUL character reaches send with U+FFFD", () => {
    document.body.innerHTML = `<input id="f1" name="f1">`;
    const { timers, sent } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    field.value = "a\u0000b";
    field.dispatchEvent(
      trustedEvent(new Event("input", { bubbles: true, composed: true })),
    );
    timers.advance(750);
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(1);
    expect(JSON.stringify(typed[0])).toContain("a\uFFFDb");
    expect(JSON.stringify(typed[0])).not.toContain("\\u0000");
    expect(sent.filter((e) => e.name === "recorder.dropped")).toEqual([]);
  });

  test("capture is clicks and inputs only", () => {
    document.body.innerHTML = `<button id="b">Save</button>`;
    const { sent } = drive();
    expect(sent.map((event) => event.name)).toEqual(["page"]);
  });

  test("a 2FA code typed into a real sign-in's code field, with no autocomplete=one-time-code, never leaves in any copy", () => {
    // The field exactly as the sign-in served it; its framework mirrors what is typed into the value attribute.
    document.body.innerHTML = `<label id="FormControl-label2">Code</label><input id="codeEntry" type="text" placeholder="Enter 6-digit code" data-test-id="two-factor-code-input" aria-labelledby="FormControl-label2"><button id="b">Log in</button>`;
    const { timers, sent } = drive();
    const field = document.getElementById("codeEntry") as HTMLInputElement;
    field.dispatchEvent(
      trustedEvent(new MouseEvent("click", { bubbles: true, composed: true })),
    );
    for (const typed of ["8", "88", "880", "8802", "88026", "880261"]) {
      field.value = typed;
      field.setAttribute("value", typed);
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
    }
    timers.advance(750);
    field.dispatchEvent(
      trustedEvent(new MouseEvent("click", { bubbles: true, composed: true })),
    );
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("880");
    const target = (
      typed[0]?.value as { target: Record<string, unknown> } | undefined
    )?.target as { value?: string; attributes: Record<string, string> };
    expect(target.value).toBe("[redacted]");
    expect(target.attributes.value).toBe("[redacted]");
    expect(target.attributes["data-test-id"]).toBe("two-factor-code-input");
  });
});

describe("startEventCapture drop reports", () => {
  test("a delivery failure is counted and reported once as recorder.dropped", () => {
    document.body.innerHTML = `<button id="b">Save</button>`;
    const timers = fakeTimers();
    const sent: CapturedEvent[] = [];
    let failing = true;
    const capture = startEventCapture({
      tracker: newTracker(),
      send: (event) => {
        if (failing) throw new Error("port gone");
        sent.push(event);
      },
      timers,
    });
    stops.push(capture.stop);
    // The page event at start failed already; two clicks fail too.
    const button = document.getElementById("b") as HTMLElement;
    for (let i = 0; i < 2; i++)
      button.dispatchEvent(
        trustedEvent(
          new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
        ),
      );
    failing = false;
    timers.advance(4_999);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "recorder.dropped",
      value: { count: 3, reason: "PERSISTENCE_UNKNOWN" },
    });
    timers.advance(60_000);
    expect(sent).toHaveLength(1);
  });

  test("collector errors are counted and reported once", () => {
    document.body.innerHTML = `<button id="b">Save</button>`;
    const timers = fakeTimers();
    const sent: CapturedEvent[] = [];
    const real = newTracker();
    const tracker = {
      ...real,
      sensitiveForEvent: (name: string) => {
        if (name === "click") throw new Error("tracker failed");
        return real.sensitiveForEvent(name);
      },
    };
    let calls = 0;
    const capture = startEventCapture({
      tracker,
      send: (event) => {
        calls++;
        if (calls === 1) throw new Error("port gone");
        sent.push(event);
      },
      timers,
    });
    stops.push(capture.stop);
    const button = document.getElementById("b") as HTMLElement;
    for (let i = 0; i < 2; i++)
      button.dispatchEvent(
        trustedEvent(
          new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
        ),
      );
    timers.advance(5_000);
    const dropped = () => sent.filter((e) => e.name === "recorder.dropped");
    expect(dropped()).toHaveLength(2);
    expect(dropped().map((e) => e.value)).toEqual(
      expect.arrayContaining([
        { count: 2, reason: "INVALID_EVENT" },
        { count: 1, reason: "PERSISTENCE_UNKNOWN" },
      ]),
    );
    timers.advance(5_000);
    expect(dropped()).toHaveLength(2);
  });

  test("a capture that cannot start is counted as CAPTURE_FAILED", () => {
    const timers = fakeTimers();
    const sent: CapturedEvent[] = [];
    const original = window.addEventListener;
    window.addEventListener = (() => {
      throw new Error("blocked");
    }) as typeof window.addEventListener;
    let capture: { stop(): void };
    try {
      capture = startEventCapture({
        tracker: createSensitivityTracker(),
        send: (event) => sent.push(event),
        timers,
      });
    } finally {
      window.addEventListener = original;
    }
    stops.push(capture.stop);
    timers.advance(5_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "recorder.dropped",
      value: { count: 1, reason: "CAPTURE_FAILED" },
    });
  });
});
