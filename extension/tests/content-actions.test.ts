import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { ACTION_PING_MS, installActionCapture } from "../src/content/actions";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://crm.example.test/deals/42" }),
);
afterAll(() => GlobalRegistrator.unregister());

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
});

/** happy-dom cannot create a trusted event: the test marks the ones a person made. */
const PERSON = new WeakSet<Event>();
const byPerson = <E extends Event>(event: E): E => {
  PERSON.add(event);
  return event;
};

function install() {
  let clock = 1_800_000_000_000;
  const actions: number[] = [];
  const emitted: [string, Record<string, unknown>][] = [];
  const uninstall = installActionCapture({
    emit: (name, value) => emitted.push([name, value]),
    action: (at) => actions.push(at),
    now: () => clock,
    isTrusted: (event) => PERSON.has(event),
  });
  if (!uninstall) throw new Error("not installed");
  cleanups.push(uninstall);
  return {
    actions,
    emitted,
    advance(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

test("every real action reports its time, at most once per 100 ms; a page's own dispatched event never does", () => {
  const h = install();
  const button = document.createElement("button");
  document.body.append(button);
  button.dispatchEvent(
    byPerson(new PointerEvent("pointerdown", { bubbles: true })),
  );
  button.dispatchEvent(byPerson(new MouseEvent("click", { bubbles: true })));
  expect(h.actions).toEqual([h.now]);
  h.advance(ACTION_PING_MS);
  const field = document.createElement("input");
  document.body.append(field);
  field.dispatchEvent(byPerson(new Event("input", { bubbles: true })));
  h.advance(ACTION_PING_MS);
  field.dispatchEvent(
    byPerson(new KeyboardEvent("keydown", { key: "e", bubbles: true })),
  );
  h.advance(ACTION_PING_MS);
  // A modifier on its own is no action, and a script's click is the page's.
  field.dispatchEvent(
    byPerson(new KeyboardEvent("keydown", { key: "Shift", bubbles: true })),
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  field.dispatchEvent(byPerson(new Event("change", { bubbles: true })));
  const first = h.actions[0] ?? 0;
  expect(h.actions).toEqual([
    first,
    first + ACTION_PING_MS,
    first + 2 * ACTION_PING_MS,
    first + 3 * ACTION_PING_MS,
  ]);
  expect(h.emitted).toEqual([]);
});

test("a form submitted is a submit event naming the form and its button, never what was typed", () => {
  const h = install();
  document.body.innerHTML = `
    <form id="login" name="login" method="post" action="/session?token=abc">
      <input name="user" value="ada">
      <input name="password" type="password" value="hunter2">
      <button id="go" type="submit">Sign in</button>
    </form>`;
  const form = document.querySelector("form") as HTMLFormElement;
  const submit = byPerson(new Event("submit", { bubbles: true }));
  Object.defineProperty(submit, "submitter", {
    value: document.querySelector("#go"),
  });
  form.dispatchEvent(submit);
  form.dispatchEvent(new Event("submit", { bubbles: true }));
  expect(h.emitted).toEqual([
    [
      "submit",
      {
        url: location.href,
        route: location.pathname,
        target: {
          tag: "form",
          role: null,
          attributes: { id: "login", name: "login", method: "post" },
        },
        submitter: {
          tag: "button",
          role: null,
          attributes: { id: "go", type: "submit" },
        },
      },
    ],
  ]);
  expect(JSON.stringify(h.emitted)).not.toContain("hunter2");
  expect(JSON.stringify(h.emitted)).not.toContain("ada");
  expect(h.actions).toHaveLength(1);
});

test("Enter in a field is a key event; Shift+Enter, a composition, or Enter outside a field is not", () => {
  const h = install();
  document.body.innerHTML = `
    <textarea id="message" placeholder="Ask anything">What should I do?</textarea>
    <div id="editor" contenteditable="true">Hello</div>
    <input id="agree" type="checkbox">
    <button id="send">Send</button>`;
  const press = (selector: string, init: KeyboardEventInit) =>
    (document.querySelector(selector) as HTMLElement).dispatchEvent(
      byPerson(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }),
      ),
    );
  press("#message", {});
  press("#message", { shiftKey: true });
  press("#message", { isComposing: true });
  press("#editor", {});
  press("#agree", {});
  press("#send", {});
  expect(h.emitted).toEqual([
    [
      "key",
      {
        key: "Enter",
        url: location.href,
        route: location.pathname,
        target: {
          tag: "textarea",
          role: null,
          attributes: { id: "message", placeholder: "Ask anything" },
        },
      },
    ],
    [
      "key",
      {
        key: "Enter",
        url: location.href,
        route: location.pathname,
        target: { tag: "div", role: null, attributes: { id: "editor" } },
      },
    ],
  ]);
  expect(JSON.stringify(h.emitted)).not.toContain("What should I do");
});

test("submit and Enter reach the recording through the collector, masked like any event, and actions are reported", () => {
  const sent: CapturedEvent[] = [];
  const actions: number[] = [];
  const capture = startEventCapture({
    tracker: createSensitivityTracker(),
    send: (event) => sent.push(event),
    onAction: (at) => actions.push(at),
  });
  cleanups.push(capture.stop);
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL("https://crm.example.test/deals/42?token=abc");
  document.body.innerHTML = `<form id="note"><textarea id="text"></textarea></form>`;
  // happy-dom marks no event trusted, and the capture keeps to trusted ones: give these the mark a person's would carry.
  const trusted = <E extends Event>(event: E): E => {
    Object.defineProperty(event, "isTrusted", { value: true });
    return event;
  };
  (document.querySelector("#text") as HTMLElement).dispatchEvent(
    trusted(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  (document.querySelector("form") as HTMLFormElement).dispatchEvent(
    trusted(new Event("submit", { bubbles: true })),
  );
  const names = sent.map((event) => event.name);
  expect(names).toContain("key");
  expect(names).toContain("submit");
  const key = sent.find((event) => event.name === "key");
  expect((key?.value as { url?: string } | undefined)?.url).toContain(
    "token=[redacted]",
  );
  expect(actions.length).toBeGreaterThan(0);
});
