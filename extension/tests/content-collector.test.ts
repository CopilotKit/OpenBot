import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type CapturedEvent,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import { act, createElement, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  collectorBeforeSend,
  startEventCapture,
} from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import {
  CARD_AND_PIN_CLOCK,
  CODE_CLOCK,
  recordedText,
} from "./support/recorded-text";

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

/** CopilotKit's input capture holds a field's text edit until typing pauses for this long (TEXT_DEBOUNCE_MS in
 * @copilotkit/learning's inputs.ts), on the page's own clock. */
const SETTLE_MS = 300;
function useCollectorClock() {
  jest.useFakeTimers();
  tracked.push(() => jest.useRealTimers());
  return { settle: () => jest.advanceTimersByTime(SETTLE_MS) };
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
    const beforeSend = collectorBeforeSend(createSensitivityTracker());
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
    const beforeSend = collectorBeforeSend(createSensitivityTracker());
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
      (reason) => dropped.push(reason),
    );
    expect(beforeSend(null as never)).toBeNull();
    expect(dropped).toEqual(["unreadable"]);
  });

  test("a page event is never a step: the service worker records each page change itself", () => {
    const beforeSend = collectorBeforeSend(createSensitivityTracker());
    const page = {
      type: "CUSTOM",
      name: "page",
      timestamp: 1,
      value: { url: "https://example.test/", title: "Home" },
    };
    expect(beforeSend(page as never)).toBeNull();
  });

  test("run 1's edit, with a card in its value and the card's first 15 digits in its text, leaves with no part of the card", () => {
    const run = JSON.parse(
      readFileSync(
        join(import.meta.dir, "fixtures/e2e-run1-card-edit.json"),
        "utf8",
      ),
    ) as {
      recorded: CapturedEvent & { value: { target: Record<string, unknown> } };
      copilotkit: { value: { target: { value: string } } };
    };
    const beforeSend = collectorBeforeSend(createSensitivityTracker());
    // As the Recorder's collector built it: the value as CopilotKit's capture read it on the same keystroke. And as
    // Intelligence stored it, masked once already.
    const built = structuredClone(run.recorded);
    built.value.target.value = run.copilotkit.value.target.value;
    for (const event of [built, run.recorded]) {
      const out = beforeSend(event as never) as unknown as {
        value: { target: Record<string, unknown> };
      };
      const target = out.value.target;
      expect(target.value).toBe(
        "Please look up this deal's history and then get it approved. Card on file for the invoice: [redacted]",
      );
      expect(target.text).toBe(target.value);
      const { seq: _seq, ...value } = out.value as Record<string, unknown>;
      const text = JSON.stringify(value);
      expect(text).not.toContain("4111 1111 1111");
      expect(text.replace(/\D/g, "")).not.toContain("411111111111");
      // Everything else the edit says about its field is as the page had it.
      expect(target.attributes).toEqual(run.recorded.value.target.attributes);
      expect(target.name).toBe("Type a message...");
    }
  });

  test("enrich adds what it finds before masking, so the masking covers it too", () => {
    const digests = new Set([sha256HexSync("hunter-two")]);
    const tracker = {
      ...createSensitivityTracker(),
      digests: () => digests,
    };
    const beforeSend = collectorBeforeSend(tracker, undefined, (event) => ({
      ...event,
      value: {
        ...(event.value as Record<string, unknown>),
        selectors: [{ by: "text", selector: 'text="hunter-two"' }],
        page: { url: "https://example.test/?token=abc", title: "Home" },
      },
    }));
    const out = beforeSend({
      type: "CUSTOM",
      name: "click",
      timestamp: 1,
      value: { target: { tag: "button", text: "Go" } },
    } as never);
    expect(JSON.stringify(out)).not.toContain("hunter-two");
    expect(JSON.stringify(out)).not.toContain("token=abc");
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

  test("keystrokes in one field become one input event once typing pauses", () => {
    document.body.innerHTML = `<input id="f1" name="f1">`;
    const clock = useCollectorClock();
    const { sent } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    for (const value of ["h", "he", "hel", "hell", "hello"]) {
      field.value = value;
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
      jest.advanceTimersByTime(20);
    }
    const typed = () => sent.filter((event) => event.name === "input");
    expect(typed()).toHaveLength(0);
    clock.settle();
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

  test("a change right after typing lets the typed value go at once, and only once", () => {
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
    // CopilotKit's capture takes the change as the echo of the edit it holds: the edit goes now, the echo never.
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(1);
    expect(typed[0]?.value).toMatchObject({
      eventType: "input",
      target: { value: "abc" },
    });
  });

  test("typing in two fields in turn sends each visit's value as the next field begins", () => {
    document.body.innerHTML = `<input id="f1" name="f1"><input id="f2" name="f2">`;
    const clock = useCollectorClock();
    const { sent } = drive();
    for (const id of ["f1", "f2", "f1", "f2"]) {
      const field = document.getElementById(id) as HTMLInputElement;
      field.value += "x";
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
    }
    clock.settle();
    const typed = sent.filter((event) => event.name === "input");
    expect(
      typed.map((event) => {
        const value = event.value as {
          target: { attributes: Record<string, string>; value: string };
        };
        return `${value.target.attributes.id}=${value.target.value}`;
      }),
    ).toEqual(["f1=x", "f2=x", "f1=xx", "f2=xx"]);
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
    const clock = useCollectorClock();
    const { sent } = drive();
    const field = document.getElementById("f1") as HTMLInputElement;
    field.value = "a\u0000b";
    field.dispatchEvent(
      trustedEvent(new Event("input", { bubbles: true, composed: true })),
    );
    clock.settle();
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(1);
    expect(JSON.stringify(typed[0])).toContain("a\uFFFDb");
    expect(JSON.stringify(typed[0])).not.toContain("\\u0000");
    expect(sent.filter((e) => e.name === "recorder.dropped")).toEqual([]);
  });

  test("capture is the person's steps only: starting sends nothing, not even the collector's page event", () => {
    document.body.innerHTML = `<button id="b">Save</button>`;
    const { sent } = drive();
    expect(sent).toEqual([]);
  });

  test("a 2FA code typed into a real sign-in's code field, with no autocomplete=one-time-code, never leaves in any copy", () => {
    // The events' timestamps hold the code's digits, which the leak check below must not read as the code.
    const settling = useCollectorClock();
    const clock = spyOn(Date, "now").mockReturnValue(CODE_CLOCK);
    tracked.push(() => clock.mockRestore());
    // The field exactly as the sign-in served it; its framework mirrors what is typed into the value attribute.
    document.body.innerHTML = `<label id="FormControl-label2">Code</label><input id="codeEntry" type="text" placeholder="Enter 6-digit code" data-test-id="two-factor-code-input" aria-labelledby="FormControl-label2"><button id="b">Log in</button>`;
    const { sent } = drive();
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
    settling.settle();
    field.dispatchEvent(
      trustedEvent(new MouseEvent("click", { bubbles: true, composed: true })),
    );
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(1);
    expect(recordedText(sent)).not.toContain("880");
    const target = (
      typed[0]?.value as { target: Record<string, unknown> } | undefined
    )?.target as { value?: string; attributes: Record<string, string> };
    expect(target.value).toBe("[redacted]");
    expect(target.attributes.value).toBe("[redacted]");
    expect(target.attributes["data-test-id"]).toBe("two-factor-code-input");
  });
});

describe("startEventCapture with a code typed a digit per box", () => {
  test("a code typed into six unlabelled one-character boxes never leaves in any box's input event", () => {
    // Six text boxes, one character each, each in its own wrapper, no label: the page moves focus along as each is filled
    // and mirrors the value into the attribute.
    document.body.innerHTML = `<form>${[1, 2, 3, 4, 5, 6]
      .map(
        (n) =>
          `<div class="cell"><input id="otp-${n}" type="text" maxlength="1" autocomplete="off"></div>`,
      )
      .join("")}<button id="b" type="button">Verify</button></form>`;
    const clock = useCollectorClock();
    const timers = fakeTimers();
    const sent: CapturedEvent[] = [];
    const tracker = newTracker();
    const capture = startEventCapture({
      tracker,
      send: (event) => sent.push(event),
      timers,
    });
    stops.push(capture.stop);
    const reported: string[] = [];
    tracker.onSensitiveValue((digest) => reported.push(digest));
    [..."731946"].forEach((digit, index) => {
      const box = document.getElementById(
        `otp-${index + 1}`,
      ) as HTMLInputElement;
      box.focus();
      box.value = digit;
      box.setAttribute("value", digit);
      box.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
    });
    clock.settle();
    const typed = sent.filter((event) => event.name === "input");
    expect(typed).toHaveLength(6);
    for (const event of typed) {
      const target = (event.value as { target: Record<string, unknown> })
        .target as { value?: string; attributes: Record<string, string> };
      expect(target.value).toBe("[redacted]");
      expect(target.attributes.value).toBe("[redacted]");
    }
    expect(reported).toContain(sha256HexSync("731946"));
  });
});

describe("startEventCapture targeting of held edits", () => {
  test("an edit that leaves while the next field is being typed in carries its own field's selectors", () => {
    // CopilotKit's capture holds each field's edit until typing there pauses or another field is edited, so box 1's value
    // leaves the moment box 2 receives its first input: it must still name box 1.
    document.body.innerHTML = `<form>${[1, 2, 3]
      .map((n) => `<input id="part-${n}" name="part-${n}" type="text">`)
      .join("")}</form>`;
    const clock = useCollectorClock();
    const sent: CapturedEvent[] = [];
    const capture = startEventCapture({
      tracker: newTracker(),
      send: (event) => sent.push(event),
      timers: fakeTimers(),
    });
    stops.push(capture.stop);
    for (const [index, text] of ["alpha", "bravo", "charlie"].entries()) {
      const field = document.getElementById(
        `part-${index + 1}`,
      ) as HTMLInputElement;
      field.value = text;
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
    }
    clock.settle();
    const edits = sent
      .filter((event) => event.name === "input")
      .map((event) => {
        const value = event.value as {
          target: { value: string };
          selectors?: { by: string; selector: string }[];
        };
        return `${value.target.value} ${value.selectors?.find((s) => s.by === "id")?.selector}`;
      });
    expect(edits).toEqual([
      "alpha #part-1",
      "bravo #part-2",
      "charlie #part-3",
    ]);
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
    // Two clicks fail to reach the port.
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
      value: { count: 2, reason: "PERSISTENCE_UNKNOWN" },
    });
    timers.advance(60_000);
    expect(sent).toHaveLength(1);
  });

  test("collector errors are counted and reported once", () => {
    document.body.innerHTML = `<button id="b">Save</button>`;
    const timers = fakeTimers();
    const sent: CapturedEvent[] = [];
    const real = newTracker();
    let clicks = 0;
    const tracker = {
      ...real,
      // The first two clicks cannot be read; the third is, and its delivery fails.
      sensitiveForEvent: (name: string) => {
        if (name === "click" && ++clicks <= 2)
          throw new Error("tracker failed");
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
    for (let i = 0; i < 3; i++)
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

describe("startEventCapture on a React chat box", () => {
  // Run 1 of the end-to-end check: the person typed this into CopilotKit's chat box (a React-controlled textarea, its
  // attributes exactly as the page served them) and pressed Send.
  const CARD = "4111 1111 1111 1111";
  const MESSAGE = `Please look up this deal's history and then get it approved. Card on file for the invoice: ${CARD}`;
  const CHAT_BOX = {
    "data-testid": "copilot-chat-textarea",
    placeholder: "Type a message...",
    rows: 1,
    className:
      "cpk:bg-transparent cpk:outline-none cpk:antialiased cpk:font-regular cpk:text-[16px] cpk:placeholder:text-[#00000077] cpk:dark:placeholder:text-[#fffc] cpk:w-full cpk:py-3 cpk:px-5",
    style: { overflow: "auto", resize: "none", maxHeight: 144, height: 72 },
  } as const;

  /** A controlled field, rendered by React: each input sets its state and React renders it, which writes the value into
   * the field's default value (react-dom 19 `updateTextarea` and `updateInput`): a textarea's text, an input's `value`
   * attribute. The state is set from the field's own input listener rather than React's onChange, whose input-event
   * support react-dom decides once, when it is first loaded, and the suite may load it before any DOM exists. */
  function ControlledField(props: {
    tag: "textarea" | "input";
    attributes: Record<string, unknown>;
  }) {
    const [text, setText] = useState("");
    const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
    useEffect(() => {
      const field = ref.current;
      if (!field) return;
      const onInput = () => flushSync(() => setText(field.value));
      field.addEventListener("input", onInput);
      return () => field.removeEventListener("input", onInput);
    }, []);
    return createElement(props.tag, {
      ...props.attributes,
      ref,
      value: text,
      onChange: () => {},
    });
  }

  /** Types `text` a character at a time as Chrome does: the field's value changes, then a trusted input event goes out,
   * which the collector hears on the window before the page renders what was typed. */
  function typeInto(
    field: HTMLTextAreaElement | HTMLInputElement,
    text: string,
  ) {
    const prototype = Object.getPrototypeOf(field) as object;
    const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    for (let length = 1; length <= text.length; length++) {
      setValue?.call(field, text.slice(0, length));
      field.dispatchEvent(
        trustedEvent(new Event("input", { bubbles: true, composed: true })),
      );
    }
  }

  async function renderField(
    tag: "textarea" | "input",
    attributes: Record<string, unknown>,
  ) {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(ControlledField, { tag, attributes })),
    );
    tracked.push(() => act(() => root.unmount()));
    return host.querySelector(tag) as HTMLTextAreaElement & HTMLInputElement;
  }

  /** The content capture as a recording runs it, on the collector's clock, with every event it sends. */
  function useEditCapture() {
    // The events' timestamps hold the card's first group, which the leak checks must not read as the card.
    const clock = spyOn(Date, "now").mockReturnValue(CARD_AND_PIN_CLOCK);
    tracked.push(() => clock.mockRestore());
    const settling = useCollectorClock();
    const sent: CapturedEvent[] = [];
    const capture = startEventCapture({
      tracker: newTracker(),
      send: (event) => sent.push(event),
      timers: fakeTimers(),
    });
    stops.push(capture.stop);
    return { sent, settle: settling.settle };
  }

  const editTarget = (sent: CapturedEvent[]) => {
    const edits = sent.filter((event) => event.name === "input");
    expect(edits).toHaveLength(1);
    const [edit] = edits;
    return (
      edit as CapturedEvent & { value: { target: Record<string, unknown> } }
    ).value.target;
  };

  /** No stretch of the card leaves: not the 15 digits a copy a keystroke behind holds, not the 12 before its last group. */
  const expectNoPartOfTheCard = (sent: CapturedEvent[]) => {
    const recorded = recordedText(sent);
    expect(recorded).not.toContain("4111 1111 1111");
    expect(recorded.replace(/\D/g, "")).not.toContain("411111111111");
  };

  test("a card typed into the chat box leaves no part of it in the edit's text, which React keeps a keystroke behind the value", async () => {
    const box = await renderField("textarea", CHAT_BOX);
    const { sent, settle } = useEditCapture();
    act(() => typeInto(box, MESSAGE));
    settle();

    const target = editTarget(sent);
    // As the end-to-end run saw it: the value holds the whole card, the text one keystroke less of it.
    expect(box.value).toBe(MESSAGE);
    expect(box.textContent).toBe(MESSAGE);
    expect(target.value).toBe(
      "Please look up this deal's history and then get it approved. Card on file for the invoice: [redacted]",
    );
    expect(target.text).toBe(target.value);
    expectNoPartOfTheCard(sent);
  });

  test("a card typed into a React input leaves no part of it in the value attribute React keeps a keystroke behind", async () => {
    const field = await renderField("input", {
      type: "text",
      name: "note",
      placeholder: "Note for the invoice",
    });
    const { sent, settle } = useEditCapture();
    act(() => typeInto(field, MESSAGE));
    settle();

    const target = editTarget(sent);
    expect(field.getAttribute("value")).toBe(MESSAGE);
    expect(target.value).toBe(
      "Please look up this deal's history and then get it approved. Card on file for the invoice: [redacted]",
    );
    expect((target.attributes as Record<string, string>).value).toBe(
      target.value as string,
    );
    expect((target.attributes as Record<string, string>).name).toBe("note");
    expectNoPartOfTheCard(sent);
  });
});
