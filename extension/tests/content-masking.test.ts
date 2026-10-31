import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  maskNetworkEvent,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
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

/** happy-dom's own way to move the page to another address, as a navigation would. */
const setUrl = (url: string) =>
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);

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

  test("a show-password checkbox or button names the password field without being one; the field stays sensitive", () => {
    document.body.innerHTML = `<label for="p">Your admin password</label><input id="p" name="password" type="password"><input id="show" type="checkbox"><label for="show">Show password</label><input id="reveal" type="button" name="show_password" value="Show password">`;
    const tracker = track();
    const sent = collectClicks(tracker);
    for (const id of ["show", "reveal"]) {
      const toggle = document.getElementById(id) as HTMLElement;
      press(toggle, "pointerdown");
      press(toggle, "click");
      expect(tracker.sensitiveForEvent("click")).toBe(false);
    }
    expect(sent.map((target) => target.value)).toEqual(["on", "Show password"]);
    const password = document.getElementById("p") as HTMLInputElement;
    press(password, "pointerdown");
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

  test("a real sign-in's 2FA code field, without autocomplete=one-time-code, is sensitive and its code hashed", () => {
    document.body.innerHTML = `<label id="FormControl-label2">Code</label><input id="codeEntry" type="text" placeholder="Enter 6-digit code" data-test-id="two-factor-code-input" aria-labelledby="FormControl-label2">`;
    const tracker = track();
    const field = document.getElementById("codeEntry") as HTMLInputElement;
    focus(field);
    expect(tracker.sensitiveForEvent("input")).toBe(true);
    type(field, "880261");
    expect([...tracker.digests()]).toContain(sha256HexSync("880261"));
  });

  test("the code typed there is masked from any body afterwards, whatever key holds it", () => {
    document.body.innerHTML = `<input id="codeEntry" placeholder="Enter 6-digit code" data-test-id="two-factor-code-input">`;
    const tracker = track();
    const field = document.getElementById("codeEntry") as HTMLInputElement;
    focus(field);
    type(field, "880261");
    const masked = maskNetworkEvent(
      {
        type: "CUSTOM",
        name: "network",
        timestamp: 1,
        value: {
          url: "https://crm.example.test/api/session",
          request: {
            headers: { "content-type": "application/json" },
            body: {
              text: '{"challenge":{"answer":"880261"},"n":880261}',
              status: "captured",
            },
          },
          response: {
            headers: { "content-type": "text/plain" },
            body: { text: "accepted 880261 for ana", status: "captured" },
          },
        },
      },
      { digests: tracker.digests() },
    );
    expect(JSON.stringify(masked)).not.toContain("880261");
  });

  test.each([
    [
      "an aria-labelledby label",
      `<span id="l">Verification code</span><input id="f" aria-labelledby="l">`,
    ],
    [
      "a short numeric input",
      `<label for="f">Enter it here</label><input id="f" inputmode="numeric" maxlength="6">`,
    ],
    ["a two-factor test id", `<input id="f" data-testid="2fa-input">`],
    ["an OTP class", `<input id="f" class="form-control otp-input">`],
  ])("a one-time code field known by %s is sensitive", (_, markup) => {
    document.body.innerHTML = markup;
    const tracker = track();
    const field = document.getElementById("f") as HTMLInputElement;
    focus(field);
    expect(tracker.sensitiveForEvent("input")).toBe(true);
  });

  test("a bare code field is sensitive on a sign-in page and kept elsewhere", () => {
    const original = window.location.href;
    try {
      document.body.innerHTML = `<input id="f" name="code">`;
      const tracker = track();
      const field = document.getElementById("f") as HTMLInputElement;
      setUrl("https://shop.example.test/cart");
      focus(field);
      expect(tracker.sensitiveForEvent("input")).toBe(false);
      document.body.innerHTML = `<input id="g" name="code">`;
      setUrl("https://app.example.test/login/confirm-to-login");
      focus(document.getElementById("g") as HTMLInputElement);
      expect(tracker.sensitiveForEvent("input")).toBe(true);
    } finally {
      setUrl(original);
    }
  });

  test.each([
    [
      "zip code",
      `<label for="f">ZIP code</label><input id="f" name="zip" inputmode="numeric" maxlength="5">`,
    ],
    [
      "postal code",
      `<label for="f">Postal code</label><input id="f" autocomplete="postal-code" maxlength="8">`,
    ],
    [
      "promo code",
      `<label for="f">Promo code</label><input id="f" name="promoCode">`,
    ],
    ["coupon code", `<input id="f" placeholder="Coupon code" maxlength="8">`],
    [
      "country code",
      `<label for="f">Country code</label><input id="f" type="tel" maxlength="4">`,
    ],
  ])(
    "a %s field is not sensitive and nothing typed into it is hashed",
    (_, markup) => {
      document.body.innerHTML = markup;
      const tracker = track();
      const field = document.getElementById("f") as HTMLInputElement;
      focus(field);
      expect(tracker.sensitiveForEvent("input")).toBe(false);
      type(field, "90210");
      expect(tracker.digests().size).toBe(0);
    },
  );

  /** Six boxes, one character each, each in its own wrapper inside a form, with no label. */
  const sixBoxes = (attributes = 'type="text" maxlength="1"') =>
    `<form>${[1, 2, 3, 4, 5, 6]
      .map((n) => `<div><input id="b${n}" ${attributes}></div>`)
      .join("")}<button type="button">Verify</button></form>`;
  const box = (n: number) =>
    document.getElementById(`b${n}`) as HTMLInputElement;
  const typeAcross = (code: string) =>
    [...code].forEach((digit, index) => {
      focus(box(index + 1));
      type(box(index + 1), digit);
    });

  test("every box of a code typed a digit per box is sensitive, though no box has a label", () => {
    document.body.innerHTML = sixBoxes();
    const tracker = track();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      focus(box(n));
      expect([n, tracker.sensitiveForEvent("input")]).toEqual([n, true]);
    }
  });

  test("the code the boxes make together is hashed in order, so it is masked in any body", () => {
    document.body.innerHTML = sixBoxes();
    const tracker = track();
    typeAcross("731946");
    expect([...tracker.digests()]).toContain(sha256HexSync("731946"));
    const masked = maskNetworkEvent(
      {
        type: "CUSTOM",
        name: "network",
        timestamp: 1,
        value: {
          url: "https://crm.example.test/api/devices/approve",
          request: {
            headers: { "content-type": "application/json" },
            body: {
              text: '{"challengeResponse":"731946"}',
              status: "captured",
            },
          },
        },
      },
      { digests: tracker.digests() },
    );
    expect(JSON.stringify(masked)).not.toContain("731946");
  });

  test("numeric boxes side by side in one parent, without maxlength, are a row too", () => {
    document.body.innerHTML = `<div>${[1, 2, 3, 4]
      .map((n) => `<input id="b${n}" type="tel">`)
      .join("")}</div>`;
    const tracker = track();
    focus(box(2));
    expect(tracker.sensitiveForEvent("input")).toBe(true);
    typeAcross("4821");
    expect([...tracker.digests()]).toContain(sha256HexSync("4821"));
  });

  test("a code the page spreads across the boxes on paste, with no input event per box, is hashed once it has", async () => {
    document.body.innerHTML = sixBoxes('inputmode="numeric" maxlength="1"');
    // What a code widget does with a paste: take it over and fill every box itself.
    document.addEventListener("paste", (event) => {
      event.preventDefault();
      [..."580317"].forEach((digit, index) => {
        box(index + 1).value = digit;
      });
    });
    const tracker = track();
    focus(box(1));
    box(1).dispatchEvent(
      new Event("paste", { bubbles: true, composed: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...tracker.digests()]).toContain(sha256HexSync("580317"));
  });

  test.each([
    ["a lone middle-initial box", `<input id="b1" type="text" maxlength="1">`],
    [
      "three one-character boxes",
      `<div>${[1, 2, 3].map((n) => `<input id="b${n}" maxlength="1">`).join("")}</div>`,
    ],
    [
      "nine one-character boxes",
      `<div>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<input id="b${n}" maxlength="1">`).join("")}</div>`,
    ],
    [
      "four checkboxes",
      `<div>${[1, 2, 3, 4].map((n) => `<input id="b${n}" type="checkbox" maxlength="1">`).join("")}</div>`,
    ],
  ])("%s is not a row of code boxes", (_, markup) => {
    document.body.innerHTML = markup;
    const tracker = track();
    focus(box(1));
    expect(tracker.sensitiveForEvent("input")).toBe(false);
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
