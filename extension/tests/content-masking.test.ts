import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { sha256HexSync } from "@openbot/shared/recorder-masking";
import { collectorBeforeSend } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const trusted = { isTrusted: () => true };
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups) clean();
  cleanups = [];
  document.body.innerHTML = "";
});

function track() {
  const tracker = createSensitivityTracker(trusted);
  cleanups.push(tracker.install());
  return tracker;
}

function focus(element: HTMLElement) {
  element.focus();
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function type(element: HTMLInputElement | HTMLElement, value: string) {
  if (element instanceof HTMLInputElement) element.value = value;
  else element.textContent = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function press(element: Element, name: "pointerdown" | "click") {
  // A plain Event, so happy-dom does not forward a label's click to its control by itself: each test dispatches Chrome's
  // forwarded click explicitly.
  element.dispatchEvent(new Event(name, { bubbles: true, composed: true }));
}

type Target = {
  tag: string;
  value?: string;
  text: string;
  attributes: Record<string, string>;
};

/** Stands in for the collector's click listener: registered on window after the tracker, as index.ts orders them, it
 * describes the clicked element like `describeTarget` in @copilotkit/learning (its value, its text and every attribute)
 * and passes the click through collectorBeforeSend. */
function collectClicks(tracker: ReturnType<typeof createSensitivityTracker>) {
  const beforeSend = collectorBeforeSend(tracker, () => {});
  const sent: Target[] = [];
  const onClick = (event: Event) => {
    const element = event.composedPath()[0];
    if (!(element instanceof Element)) return;
    const masked = beforeSend({
      type: "CUSTOM",
      name: "click",
      timestamp: 1,
      value: {
        target: {
          tag: element.localName,
          text: element.textContent ?? "",
          attributes: Object.fromEntries(
            Array.from(element.attributes, ({ name, value }) => [name, value]),
          ),
          ...(element instanceof HTMLInputElement
            ? { value: element.value }
            : {}),
        },
      },
    } as never) as unknown as { value: { target: Target } };
    sent.push(masked.value.target);
  };
  window.addEventListener("click", onClick, { capture: true });
  cleanups.push(() =>
    window.removeEventListener("click", onClick, { capture: true }),
  );
  return sent;
}

describe("sensitivity tracker", () => {
  test("a field labelled only by a separate label element is redacted in value, attributes and text", () => {
    // React and server markup mirror the value into the attribute; the collector copies every attribute and the text.
    // A 3-digit code fails the Luhn check, so only the tracker's judgement of the field can redact it.
    document.body.innerHTML = `<label for="c">Card security code</label><input id="c" name="f7" value="737">`;
    const tracker = track();
    const sent = collectClicks(tracker);
    const input = document.querySelector("input") as HTMLInputElement;
    press(input, "pointerdown");
    press(input, "click");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.value).toBe("[redacted]");
    expect(sent[0]?.text).toBe("[redacted]");
    expect(sent[0]?.attributes.value).toBe("[redacted]");
    expect(JSON.stringify(sent)).not.toContain("737");
  });

  test.each([
    [
      "a separate label",
      `<label for="c">Card security code</label><input id="c" name="f7" value="737">`,
    ],
    [
      "a wrapping label",
      `<label><span>Card security code</span><input name="f7" value="737"></label>`,
    ],
  ])(
    "a click on %s is redacted in the click Chrome forwards to the field",
    (_, markup) => {
      document.body.innerHTML = markup;
      const tracker = track();
      const sent = collectClicks(tracker);
      const label = document.querySelector("label") as HTMLLabelElement;
      const input = document.querySelector("input") as HTMLInputElement;
      // What Chrome fires for a click on a label: pointerdown and click on the label, focus and a second click on the field.
      press(label, "pointerdown");
      focus(input);
      press(label, "click");
      press(input, "click");
      expect(sent.map((target) => target.tag)).toEqual(["label", "input"]);
      expect(sent[1]?.value).toBe("[redacted]");
      expect(sent[1]?.text).toBe("[redacted]");
      expect(sent[1]?.attributes.value).toBe("[redacted]");
      expect(JSON.stringify(sent)).not.toContain("737");
    },
  );

  test("an input event from a field inside a shadow root is judged by that field, not the focused host", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<label for="s">Card security code</label><input id="s" name="f7">`;
    const inner = root.querySelector("input") as HTMLInputElement;
    const tracker = track();
    inner.focus();
    expect(document.activeElement).toBe(host);
    // Below MIN_DIGEST_LENGTH, so no digest can redact it: only the tracker's judgement of the field can.
    inner.value = "73";
    const event = new Event("input", { bubbles: true, composed: true });
    // Listeners on window see a shadow-DOM event retargeted to the host; composedPath()[0] is still the inner input.
    Object.defineProperty(event, "composedPath", {
      value: () => [
        inner,
        root,
        host,
        document.body,
        document.documentElement,
        document,
        window,
      ],
    });
    host.dispatchEvent(event);
    expect(tracker.sensitiveForEvent("input")).toBe(true);
    const masked = collectorBeforeSend(tracker, () => {})({
      type: "CUSTOM",
      name: "input",
      timestamp: 1,
      value: { target: { tag: "input", value: "73", attributes: {} } },
    } as never);
    expect(JSON.stringify(masked)).toContain('"value":"[redacted]"');
  });

  test("an input event is masked from the focused sensitive field and a plain field is kept", () => {
    document.body.innerHTML = `<label for="s">Security code</label><input id="s" name="a1"><label for="n">Nickname</label><input id="n" name="a2">`;
    const tracker = track();
    const secret = document.getElementById("s") as HTMLInputElement;
    const plain = document.getElementById("n") as HTMLInputElement;
    const beforeSend = collectorBeforeSend(tracker, () => {});
    const input = (value: string) =>
      ({
        type: "CUSTOM",
        name: "input",
        timestamp: 1,
        value: { target: { tag: "input", value, attributes: {} } },
      }) as never;
    focus(secret);
    expect(JSON.stringify(beforeSend(input("abc")))).toContain("[redacted]");
    focus(plain);
    expect(JSON.stringify(beforeSend(input("abc")))).toContain('"value":"abc"');
  });

  test("a click is judged by the last pointer target", () => {
    document.body.innerHTML = `<label for="p">Password</label><input id="p" type="password"><button id="b">Save</button>`;
    const tracker = track();
    const password = document.getElementById("p") as HTMLInputElement;
    password.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(tracker.sensitiveForEvent("click")).toBe(true);
    (document.getElementById("b") as HTMLElement).dispatchEvent(
      new Event("pointerdown", { bubbles: true }),
    );
    expect(tracker.sensitiveForEvent("click")).toBe(false);
  });

  test("a keyboard-activated button is judged by itself, not by an earlier pointer target", () => {
    document.body.innerHTML = `<label for="p">Password</label><input id="p" type="password"><button id="b">Save</button>`;
    const tracker = track();
    press(document.getElementById("p") as HTMLElement, "pointerdown");
    press(document.getElementById("b") as HTMLElement, "click");
    expect(tracker.sensitiveForEvent("click")).toBe(false);
  });

  test("a click a re-render moved to the body keeps its pointerdown field, which the collector describes it by", () => {
    document.body.innerHTML = `<label for="c">Card security code</label><input id="c" name="f7" value="737">`;
    const tracker = track();
    press(document.querySelector("input") as HTMLElement, "pointerdown");
    press(document.body, "click");
    expect(tracker.sensitiveForEvent("click")).toBe(true);
  });

  test("a field that was a password field stays sensitive after its type changes", () => {
    document.body.innerHTML = `<input id="p" type="password">`;
    const tracker = track();
    const field = document.getElementById("p") as HTMLInputElement;
    focus(field);
    field.type = "text";
    focus(field);
    expect(tracker.sensitiveForEvent("input")).toBe(true);
  });

  test("a contenteditable field labelled Security code is redacted", () => {
    document.body.innerHTML = `<div id="e" contenteditable="true" aria-label="Security code"></div>`;
    const tracker = track();
    const editable = document.getElementById("e") as HTMLElement;
    focus(editable);
    expect(tracker.sensitiveForEvent("input")).toBe(true);
    const beforeSend = collectorBeforeSend(tracker, () => {});
    const masked = beforeSend({
      type: "CUSTOM",
      name: "input",
      timestamp: 1,
      value: { target: { tag: "div", text: "737", attributes: {} } },
    } as never);
    expect(JSON.stringify(masked)).not.toContain("737");
  });

  test("values typed into sensitive fields are reported only as digests, from 3 characters, normalised", () => {
    document.body.innerHTML = `<label for="a">Security code</label><input id="a"><label for="b">Card number</label><input id="b"><label for="c">Nickname</label><input id="c">`;
    const tracker = track();
    const reported: string[] = [];
    tracker.onSensitiveValue((digest) => reported.push(digest));
    const code = document.getElementById("a") as HTMLInputElement;
    const card = document.getElementById("b") as HTMLInputElement;
    const nick = document.getElementById("c") as HTMLInputElement;
    focus(code);
    type(code, "73");
    expect(reported).toEqual([]);
    type(code, "737");
    type(code, "737");
    focus(card);
    type(card, "4111 1111 1111 1111");
    focus(nick);
    type(nick, "plain value");
    const expected = [sha256HexSync("737"), sha256HexSync("4111111111111111")];
    expect(reported).toEqual(expected);
    expect([...tracker.digests()]).toEqual(expected);
    expect(JSON.stringify(reported)).not.toContain("4111");
  });

  test("a contenteditable's text is hashed too", () => {
    document.body.innerHTML = `<div id="e" contenteditable="true" aria-label="Security code"></div>`;
    const tracker = track();
    const editable = document.getElementById("e") as HTMLElement;
    focus(editable);
    type(editable, "9876");
    expect([...tracker.digests()]).toEqual([sha256HexSync("9876")]);
  });

  test("a value a password manager fills in, with untrusted events, is hashed too", () => {
    document.body.innerHTML = `<label for="a">Security code</label><input id="a"><input id="p" type="password"><label for="n">Nickname</label><input id="n">`;
    // The real check: every event dispatched here is untrusted, as a password manager's fill is.
    const tracker = createSensitivityTracker();
    cleanups.push(tracker.install());
    const reported: string[] = [];
    tracker.onSensitiveValue((digest) => reported.push(digest));
    type(document.getElementById("a") as HTMLInputElement, "737");
    const password = document.getElementById("p") as HTMLInputElement;
    password.value = "hunter2";
    password.dispatchEvent(new Event("change", { bubbles: true }));
    type(document.getElementById("n") as HTMLInputElement, "plain value");
    expect(reported).toEqual([sha256HexSync("737"), sha256HexSync("hunter2")]);
  });

  test("an untrusted fill never moves the field the next input event is judged by", () => {
    document.body.innerHTML = `<label for="n">Nickname</label><input id="n"><input id="p" type="password">`;
    const trustedEvents = new WeakSet<Event>();
    const tracker = createSensitivityTracker({
      isTrusted: (event) => trustedEvents.has(event),
    });
    cleanups.push(tracker.install());
    const nick = document.getElementById("n") as HTMLInputElement;
    const typed = new Event("input", { bubbles: true, composed: true });
    trustedEvents.add(typed);
    nick.value = "Al";
    nick.dispatchEvent(typed);
    type(document.getElementById("p") as HTMLInputElement, "hunter2");
    expect(tracker.sensitiveForEvent("input")).toBe(false);
    expect([...tracker.digests()]).toEqual([sha256HexSync("hunter2")]);
  });

  test("a digest is reported on a plain-http page, where crypto.subtle does not exist", () => {
    document.body.innerHTML = `<label for="a">Security code</label><input id="a">`;
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const tracker = track();
      const code = document.getElementById("a") as HTMLInputElement;
      focus(code);
      type(code, "737");
      expect([...tracker.digests()]).toEqual([sha256HexSync("737")]);
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });

  test("install's cleanup removes the listeners", () => {
    document.body.innerHTML = `<label for="a">Security code</label><input id="a">`;
    const tracker = createSensitivityTracker(trusted);
    const off = tracker.install();
    off();
    const code = document.getElementById("a") as HTMLInputElement;
    focus(code);
    type(code, "737");
    expect(tracker.digests().size).toBe(0);
  });
});
