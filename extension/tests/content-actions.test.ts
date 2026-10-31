import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createTrajectoryCollector } from "@copilotkit/learning";
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
  const capture = installActionCapture({
    emit: (name, value) => emitted.push([name, value]),
    isTrusted: (event) => PERSON.has(event),
  });
  if (!capture) throw new Error("not installed");
  cleanups.push(capture.uninstall);
  return emitted;
}

test("a form submitted with no click or Enter to explain it is a submit step naming the form and its button, with their targeting, never what was typed", () => {
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
      ariaRole: "form",
      name: "Sign in",
      attributes: { id: "login", name: "login", method: "post" },
    },
    selectors: [
      { by: "role", selector: 'role=form[name="Sign in"]' },
      { by: "id", selector: "#login" },
      { by: "name", selector: 'form[name="login"]' },
      { by: "css", selector: "html > body > form" },
    ],
    submitter: {
      tag: "button",
      ariaRole: "button",
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
      ariaRole: "textbox",
      name: "Ask about this deal",
      inputType: "textarea",
      attributes: { id: "message", placeholder: "Ask anything" },
    },
  });
  expect(emitted[1]?.[1]).toMatchObject({
    target: {
      tag: "div",
      ariaRole: "textbox",
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
  const text = document.querySelector("#text") as HTMLElement;
  text.dispatchEvent(
    trusted(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  text.dispatchEvent(
    trusted(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })),
  );
  // Submitted later, by nothing the person did that a step explains (the page's own requestSubmit after a save).
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

// ---- One action, one row, beside CopilotKit main's own capture of the same page --------------------------------------
//
// Each test below runs the Recorder's capture and a bare CopilotKit collector (@copilotkit/learning, main) on the same
// page at once, and plays the events Chrome dispatches for the action, in Chrome's order and tasks. Every event
// CopilotKit's collector sends, the Recorder sends exactly the same (its own fields as CopilotKit wrote them, the
// Recorder's targeting beside them); the Recorder adds a step of its own only for an action CopilotKit records nothing
// of. The pages are the Corner Shop admin's of end-to-end run 1, where each of these actions became two or three rows.

/** happy-dom marks no event trusted, and both captures keep to trusted ones: give these the mark a person's would carry.
 * (happy-dom's own default actions, a toggled box's input or a submit button's submit, stay untrusted and are ignored:
 * the tests dispatch Chrome's own.) */
const chrome = <E extends Event>(event: E): E => {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
};
/** The next task: Chrome runs what an event's default action does in the same task as the event, and the next input
 * event in a later one. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const setPage = (url: string) =>
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);

type Captured = { name: string; value: Record<string, unknown> };

/** The Recorder's capture and CopilotKit's own, side by side on this page. */
function bothCaptures() {
  const recorder: Captured[] = [];
  const copilotkit: Captured[] = [];
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  cleanups.push(tracker.install());
  const capture = startEventCapture({
    tracker,
    send: (event) => recorder.push(event as unknown as Captured),
  });
  cleanups.push(capture.stop);
  const bare = createTrajectoryCollector({
    capture: { clicks: true, inputs: true, navigation: false, network: false },
    send: (event) => {
      if (event.name !== "page") copilotkit.push(event as unknown as Captured);
    },
  });
  bare.start();
  cleanups.push(() => bare.stop());
  return { recorder, copilotkit };
}

/** What CopilotKit's ClickTarget holds (@copilotkit/learning types.ts), and the fields of its click and input events. */
const COPILOTKIT_TARGET = [
  "tag",
  "role",
  "action",
  "text",
  "label",
  "attributes",
  "value",
  "checked",
  "selectedValues",
  "files",
  "input",
] as const;
const COPILOTKIT_EVENT = ["eventType", "url", "route"] as const;

/** Every event CopilotKit sent, the Recorder sent too, in the same order, with CopilotKit's own fields unchanged. */
function expectParity(recorder: Captured[], copilotkit: Captured[]) {
  const shared = recorder.filter(
    ({ name }) => name === "click" || name === "input",
  );
  expect(shared.map(({ name }) => name)).toEqual(
    copilotkit.map(({ name }) => name),
  );
  copilotkit.forEach((theirs, index) => {
    const ours = shared[index]?.value ?? {};
    const pick = (value: Record<string, unknown>) => ({
      ...Object.fromEntries(COPILOTKIT_EVENT.map((key) => [key, value[key]])),
      target: Object.fromEntries(
        COPILOTKIT_TARGET.map((key) => [
          key,
          (value.target as Record<string, unknown>)[key],
        ]),
      ),
    });
    expect(pick(ours)).toEqual(pick(theirs.value));
  });
}

const press = (element: Element, type: string, init: MouseEventInit = {}) =>
  element.dispatchEvent(
    chrome(
      new MouseEvent(type, {
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      }),
    ),
  );
const key = (element: Element, type: string, init: KeyboardEventInit = {}) =>
  element.dispatchEvent(
    chrome(
      new KeyboardEvent(type, {
        key: "Enter",
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      }),
    ),
  );
const submitEvent = (form: HTMLFormElement, submitter: Element | null) => {
  const event = chrome(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  Object.defineProperty(event, "submitter", { value: submitter });
  form.dispatchEvent(event);
};
const typeInto = (field: HTMLInputElement, text: string) => {
  field.value = text;
  field.dispatchEvent(
    chrome(new Event("input", { bubbles: true, composed: true })),
  );
};
const steps = (events: Captured[]) =>
  events.map(({ name, value }) => [name, value.step]);

test("a click on a form's submit button is one step, CopilotKit's click: the submit it makes adds nothing", async () => {
  // The shop's refund form (end-to-end run 1, rows 8039 and 8040: a click on Send refund, then a submit holding the save).
  setPage("http://127.0.0.1:7420/checkout?order=1043");
  document.body.innerHTML = `<main><h1>Refund to card</h1><form id="refund-form">
<label for="full-name">Name on the refund</label><input id="full-name" name="fullName" autocomplete="name">
<label for="reason">Reason</label><textarea id="reason" name="reason"></textarea>
<label for="notes">Notes for the team</label><textarea id="notes" name="notes"></textarea>
<button id="pay" type="submit">Send refund</button>
</form><pre id="result"></pre></main>`;
  const { recorder, copilotkit } = bothCaptures();
  const pay = document.querySelector("#pay") as HTMLButtonElement;
  // One task: the click, and the submit Chrome makes as its default action.
  press(pay, "pointerdown", { detail: 1 });
  press(pay, "click", { detail: 1 });
  submitEvent(pay.form as HTMLFormElement, pay);
  await nextTask();
  expect(steps(recorder)).toEqual([["click", "click"]]);
  expect(recorder[0]?.value.target).toMatchObject({
    tag: "button",
    role: null,
    ariaRole: "button",
    name: "Send refund",
    input: "pointer",
  });
  expectParity(recorder, copilotkit);
});

test("Enter in a field whose form has a submit button is the click Chrome makes on that button: no key and no submit", async () => {
  // The shop's account form (end-to-end run 1, rows 8053 to 8055: a key, a keyboard click on Save account, a submit).
  setPage("http://127.0.0.1:7420/account");
  document.body.innerHTML = `<main><h1>Account</h1><form id="account" method="post" action="/api/account/update">
<label for="display-name">Display name</label><input id="display-name" name="displayName" value="Shop Admin">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="">
<label for="support-note">Note to support</label><input id="support-note" name="supportNote">
<label for="memo">Internal memo</label><input id="memo" name="memo">
<button type="submit" class="ghost">Save account</button>
</form><pre id="acct"></pre></main>`;
  const { recorder, copilotkit } = bothCaptures();
  const memo = document.querySelector("#memo") as HTMLInputElement;
  const save = document.querySelector("button") as HTMLButtonElement;
  typeInto(memo, "Ring the courier first");
  key(memo, "keydown");
  await nextTask();
  // Enter's keypress: Chrome clicks the form's default button (detail 0) and submits the form, in this one task.
  key(memo, "keypress");
  press(save, "click", { detail: 0 });
  submitEvent(memo.form as HTMLFormElement, save);
  await nextTask();
  key(memo, "keyup");
  await nextTask();
  expect(steps(recorder)).toEqual([
    ["input", "input"],
    ["click", "click"],
  ]);
  expect(recorder[1]?.value.target).toMatchObject({
    tag: "button",
    ariaRole: "button",
    name: "Save account",
    input: "keyboard",
  });
  expectParity(recorder, copilotkit);
});

test("Enter in a field whose form has no button is the Recorder's key, as CopilotKit records nothing of it: the submit it makes adds nothing", async () => {
  // The shop's order search (end-to-end run 1, rows 8007 and 8009: a key and then a submit for one Enter).
  setPage("http://127.0.0.1:7420/");
  document.body.innerHTML = `<main><h1>Today</h1><p class="muted">Search orders (press Enter):</p><form id="search" action="/search" method="get" role="search"><input name="q" aria-label="Search orders" placeholder="Order number or customer"></form></main>`;
  const { recorder, copilotkit } = bothCaptures();
  const field = document.querySelector('input[name="q"]') as HTMLInputElement;
  typeInto(field, "1043");
  key(field, "keydown");
  await nextTask();
  // Enter's keypress: with no button to click, Chrome submits the form.
  key(field, "keypress");
  submitEvent(field.form as HTMLFormElement, null);
  await nextTask();
  key(field, "keyup");
  await nextTask();
  expect(steps(recorder)).toEqual([
    ["input", "input"],
    ["key", "enter"],
  ]);
  expect(recorder[1]?.value.target).toMatchObject({
    tag: "input",
    ariaRole: "textbox",
    name: "Search orders",
  });
  expect(copilotkit.map(({ name }) => name)).toEqual(["input"]);
  expectParity(recorder, copilotkit);
});

test("Enter a page stops at keydown, in a form with a submit button, is the key, sent once the keydown has run", async () => {
  setPage("http://127.0.0.1:7420/account");
  document.body.innerHTML = `<form id="account"><label for="memo">Internal memo</label><input id="memo" name="memo"><button type="submit">Save account</button></form>`;
  const memo = document.querySelector("#memo") as HTMLInputElement;
  // The page's own handler: Enter picks a suggestion instead of submitting, so Chrome makes no keypress and no click.
  memo.addEventListener("keydown", (event) => event.preventDefault());
  const { recorder, copilotkit } = bothCaptures();
  key(memo, "keydown");
  expect(steps(recorder)).toEqual([]);
  await nextTask();
  expect(steps(recorder)).toEqual([["key", "enter"]]);
  key(memo, "keyup");
  await nextTask();
  expect(steps(recorder)).toEqual([["key", "enter"]]);
  expect(copilotkit).toEqual([]);
});

test("a box ticked is CopilotKit's click and its input, both kept as CopilotKit sends them, the input a check step", async () => {
  // The shop's order page (end-to-end run 1, rows 8014 and 8015: the input arrived as an `input` step).
  setPage("http://127.0.0.1:7420/orders/1043");
  document.body.innerHTML = `<main><h1>Order 1043</h1>
<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="notify"> Notify the customer by email</label></main>`;
  const { recorder, copilotkit } = bothCaptures();
  const notify = document.querySelector("#notify") as HTMLInputElement;
  // One task: the click (Chrome ticks the box before dispatching it), then the input and change it fires.
  press(notify, "pointerdown", { detail: 1 });
  press(notify, "click", { detail: 1 });
  notify.dispatchEvent(
    chrome(new Event("input", { bubbles: true, composed: true })),
  );
  notify.dispatchEvent(
    chrome(new Event("change", { bubbles: true, composed: true })),
  );
  await nextTask();
  expect(steps(recorder)).toEqual([
    ["click", "click"],
    ["input", "check"],
  ]);
  expect(recorder[1]?.value).toMatchObject({
    eventType: "input",
    target: {
      checked: true,
      ariaRole: "checkbox",
      name: "Notify the customer by email",
    },
  });
  expectParity(recorder, copilotkit);
});

test("a choice in a list is a select step naming the chosen option as the person read it, CopilotKit's value and text unchanged", async () => {
  // The shop's order status (end-to-end run 1, row 8013: an `input` step whose only sign of the choice was "returned").
  setPage("http://127.0.0.1:7420/orders/1043");
  document.body.innerHTML = `<main><h1>Order 1043</h1>
<label for="status">Status</label><select id="status" name="status"><option value="processing">Processing</option><option value="shipped">Shipped</option><option value="delivered" selected>Delivered</option><option value="returned">Returned</option></select></main>`;
  const { recorder, copilotkit } = bothCaptures();
  const status = document.querySelector("#status") as HTMLSelectElement;
  // Chrome sets the value as the person picks, then fires input and change.
  status.value = "returned";
  status.dispatchEvent(
    chrome(new Event("input", { bubbles: true, composed: true })),
  );
  status.dispatchEvent(
    chrome(new Event("change", { bubbles: true, composed: true })),
  );
  await nextTask();
  expect(steps(recorder)).toEqual([["input", "select"]]);
  expect(recorder[0]?.value).toMatchObject({
    eventType: "input",
    target: {
      value: "returned",
      selectedValues: ["returned"],
      selectedLabels: ["Returned"],
      text: "ProcessingShippedDeliveredReturned",
      ariaRole: "combobox",
      name: "Status",
    },
  });
  expectParity(recorder, copilotkit);
});
