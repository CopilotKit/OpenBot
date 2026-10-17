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

describe("sensitivity tracker", () => {
  test("a field labelled only by a separate label element is redacted in value, attributes and text", () => {
    // React and server markup mirror the value into the attribute; the collector copies every attribute and the text.
    document.body.innerHTML = `<label for="c">Card number</label><input id="c" name="f7" value="4111111111111111">`;
    const tracker = track();
    const input = document.querySelector("input") as HTMLInputElement;
    focus(input);
    const beforeSend = collectorBeforeSend(tracker, () => {});
    const masked = beforeSend({
      type: "CUSTOM",
      name: "click",
      timestamp: 1,
      value: {
        target: {
          tag: "input",
          value: "4111111111111111",
          text: "4111111111111111",
          attributes: { id: "c", name: "f7", value: "4111111111111111" },
        },
      },
    } as never);
    expect(masked).not.toBeNull();
    expect(JSON.stringify(masked)).not.toContain("4111111111111111");
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

  test("an untrusted event reports nothing", () => {
    document.body.innerHTML = `<label for="a">Security code</label><input id="a">`;
    const tracker = createSensitivityTracker();
    cleanups.push(tracker.install());
    const code = document.getElementById("a") as HTMLInputElement;
    focus(code);
    type(code, "737");
    expect(tracker.digests().size).toBe(0);
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
