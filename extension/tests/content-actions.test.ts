import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { installActionCapture } from "../src/content/actions";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import { CODE_CLOCK, leakedSecrets } from "./support/recorded-text";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://crm.example.test/deals/42" }),
);
afterAll(() => GlobalRegistrator.unregister());

const cleanups: (() => void)[] = [];
// The leak checks search what a step records, never its clock: pinned so a check that read the clock would fail every run.
beforeEach(() => {
  const clock = spyOn(Date, "now").mockReturnValue(CODE_CLOCK);
  cleanups.push(() => clock.mockRestore());
});
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
  const emitted: [string, Record<string, unknown>][] = [];
  const uninstall = installActionCapture({
    emit: (name, value) => emitted.push([name, value]),
    isTrusted: (event) => PERSON.has(event),
  });
  if (!uninstall) throw new Error("not installed");
  cleanups.push(uninstall);
  return emitted;
}

test("a form submitted is a submit step naming the form and its button, with their targeting, never what was typed", () => {
  const emitted = install();
  document.body.innerHTML = `
    <form id="login" name="login" method="post" action="/session?token=abc" aria-label="Sign in">
      <input name="user" value="ada">
      <input name="password" type="password" value="hunter2">
      <button id="go" type="submit" data-testid="sign-in">Sign in</button>
    </form>`;
  const form = document.querySelector("form") as HTMLFormElement;
  const submit = byPerson(new Event("submit", { bubbles: true }));
  Object.defineProperty(submit, "submitter", {
    value: document.querySelector("#go"),
  });
  form.dispatchEvent(submit);
  form.dispatchEvent(new Event("submit", { bubbles: true }));
  expect(emitted).toHaveLength(1);
  const [name, value] = emitted[0] ?? [];
  expect(name).toBe("submit");
  expect(value).toMatchObject({
    step: "submit",
    url: location.href,
    route: location.pathname,
    target: {
      tag: "form",
      role: "form",
      name: "Sign in",
      attributes: { id: "login", name: "login", method: "post" },
    },
    selectors: [
      { by: "id", selector: "#login" },
      { by: "name", selector: 'form[name="login"]' },
      { by: "role", selector: 'role=form[name="Sign in"]' },
      { by: "css", selector: "html > body > form" },
    ],
    submitter: {
      tag: "button",
      role: "button",
      name: "Sign in",
      attributes: { id: "go", type: "submit", "data-testid": "sign-in" },
    },
    page: { url: location.href, title: "" },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  expect(leakedSecrets(emitted, ["hunter2", "ada"])).toEqual([]);
});

test("Enter in a field is an Enter step with the field's targeting; Shift+Enter, a composition, or Enter outside a field is not", () => {
  const emitted = install();
  document.body.innerHTML = `
    <label for="message">Ask about this deal</label>
    <textarea id="message" placeholder="Ask anything">What should I do?</textarea>
    <div id="editor" contenteditable="true" aria-label="Notes">Hello</div>
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
  expect(emitted.map(([name, value]) => [name, value.key, value.step])).toEqual(
    [
      ["key", "Enter", "enter"],
      ["key", "Enter", "enter"],
    ],
  );
  expect(emitted[0]?.[1]).toMatchObject({
    target: {
      tag: "textarea",
      role: "textbox",
      name: "Ask about this deal",
      inputType: "textarea",
      attributes: { id: "message", placeholder: "Ask anything" },
    },
  });
  expect(emitted[1]?.[1]).toMatchObject({
    target: {
      tag: "div",
      role: "textbox",
      name: "Notes",
      inputType: "contenteditable",
    },
  });
  expect(leakedSecrets(emitted, ["What should I do", "Hello"])).toEqual([]);
});

test("submit and Enter reach the recording through the collector, masked like any step", () => {
  const sent: CapturedEvent[] = [];
  const capture = startEventCapture({
    tracker: createSensitivityTracker(),
    send: (event) => sent.push(event),
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
  expect(sent.map((event) => event.name)).toEqual(["key", "submit"]);
  for (const event of sent) {
    const value = event.value as { url: string; page: { url: string } };
    expect(value.url).toContain("token=[redacted]");
    expect(value.page.url).toContain("token=[redacted]");
  }
});
