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
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import {
  isGeneratedId,
  nameOf,
  roleOf,
  selectorsOf,
  targetingOf,
} from "../src/content/targeting";
import { CODE_CLOCK, leakedSecrets } from "./support/recorded-text";

beforeAll(() =>
  GlobalRegistrator.register({ url: "https://crm.example.test/contacts" }),
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
  document.title = "";
});

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;

/** happy-dom marks no event trusted, and the collector keeps to trusted ones: give these the mark a person's would carry. */
const trusted = <E extends Event>(event: E): E => {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
};

test("an id a framework made up is never a selector; a hand-made one is", () => {
  for (const id of [
    ":r1:",
    "radix-:R1mm:",
    "ember1234",
    "mui-12345",
    "3f2a9c1e-7b1d-4e2a-9c3b-1d2e3f4a5b6c",
    "a1b2c3d4e5",
    "field-20481",
  ])
    expect([id, isGeneratedId(id)]).toEqual([id, true]);
  for (const id of ["save-button", "email", "contact-form", "codeEntry"])
    expect([id, isGeneratedId(id)]).toEqual([id, false]);
});

test("the role comes from the element's own role, else its tag and type", () => {
  document.body.innerHTML = `
    <a id="a" href="/x">x</a><a id="anchor">y</a><button id="b">b</button>
    <input id="t"><input id="c" type="checkbox"><input id="s" type="submit"><input id="q" type="search">
    <select id="one"></select><select id="many" multiple></select><textarea id="ta"></textarea>
    <div id="d" role="menuitem tab">m</div><div id="ce" contenteditable="true"></div><div id="plain"></div>`;
  expect(
    [
      "#a",
      "#anchor",
      "#b",
      "#t",
      "#c",
      "#s",
      "#q",
      "#one",
      "#many",
      "#ta",
      "#d",
      "#ce",
      "#plain",
    ].map((selector) => roleOf($(selector))),
  ).toEqual([
    "link",
    null,
    "button",
    "textbox",
    "checkbox",
    "button",
    "searchbox",
    "combobox",
    "listbox",
    "textbox",
    "menuitem",
    "textbox",
    null,
  ]);
});

test("the name is what a screen reader reads: aria-labelledby, aria-label, the label, the text on it, then placeholder", () => {
  document.body.innerHTML = `
    <span id="l1">Company</span><span id="l2">name</span>
    <input id="by" aria-labelledby="l1 l2">
    <input id="aria" aria-label="Search contacts" placeholder="Search">
    <label for="for">Email address</label><input id="for">
    <label>City <input id="wrapped"></label>
    <input id="ph" placeholder="Enter 6-digit code">
    <button id="btn">  Save   changes </button>
    <a id="link" href="/c/1">Ada Lovelace</a>
    <input id="submit" type="submit" value="Send">
    <form id="f" aria-label="New company"><label>Name <input></label></form>
    <form id="unnamed"><label>Name <input></label><button>Save</button></form>
    <div id="chip" tabindex="0">What should I do next?</div>`;
  expect(
    [
      "#by",
      "#aria",
      "#for",
      "#wrapped",
      "#ph",
      "#btn",
      "#link",
      "#submit",
      "#f",
      "#unnamed",
      "#chip",
    ].map((selector) => nameOf($(selector))),
  ).toEqual([
    "Company name",
    "Search contacts",
    "Email address",
    "City",
    "Enter 6-digit code",
    "Save changes",
    "Ada Lovelace",
    "Send",
    "New company",
    // A form is never named by the text inside it.
    "",
    "What should I do next?",
  ]);
});

test("selectors come steadiest first: test attribute, hand-made id, name, role and name, text, then a short CSS path from a stable ancestor", () => {
  document.body.innerHTML = `
    <div data-testid="contact-card"><div><span>
      <button id="save-contact" name="save" data-testid="save-contact" class="x6s0dn4 xrvj5dj">Save</button>
      <button id=":r7:" class="sc-kcGFou diMWFu">Cancel</button>
    </span></div></div>`;
  const save = $('[data-testid="save-contact"]');
  expect(selectorsOf(save, "button", "Save", () => false)).toEqual([
    { by: "testid", selector: '[data-testid="save-contact"]' },
    { by: "id", selector: "#save-contact" },
    { by: "name", selector: 'button[name="save"]' },
    { by: "role", selector: 'role=button[name="Save"]' },
    { by: "text", selector: 'text="Save"' },
    {
      by: "css",
      selector:
        '[data-testid="contact-card"] > div > span > button:nth-of-type(1)',
    },
  ]);
  // A made-up id is left out, and no class name ever appears.
  const cancel = $("button:nth-of-type(2)");
  const selectors = selectorsOf(cancel, "button", "Cancel", () => false);
  expect(selectors.map((s) => s.by)).toEqual(["role", "text", "css"]);
  expect(JSON.stringify(selectors)).not.toContain("sc-kcGFou");
  expect(JSON.stringify(selectors)).not.toContain(":r7:");
});

test("nothing derived from a field ever repeats its value: a page that mirrors the value into its label loses that name", () => {
  document.body.innerHTML = `<input id="q" aria-label="Acme Holdings" name="Acme Holdings">`;
  const field = $("#q") as HTMLInputElement;
  field.value = "Acme Holdings";
  const targeting = targetingOf(field, field.value);
  expect(targeting.name).toBe("");
  expect(leakedSecrets(targeting, ["Acme Holdings"])).toEqual([]);
});

test("a step carries the page, its input type, its box and the viewport in the top frame; a frame's step carries its frame instead", () => {
  document.title = "Contacts";
  document.body.innerHTML = `<input id="email" type="email" aria-label="Email">`;
  const field = $("#email");
  Object.defineProperty(field, "getBoundingClientRect", {
    value: () => ({ x: 10.4, y: 20.6, width: 300, height: 32 }),
  });
  expect(targetingOf(field)).toMatchObject({
    role: "textbox",
    name: "Email",
    inputType: "email",
    box: { x: 10, y: 21, width: 300, height: 32 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: { url: "https://crm.example.test/contacts", title: "Contacts" },
  });
  const top = Object.getOwnPropertyDescriptor(window, "top");
  const parent = Object.getOwnPropertyDescriptor(window, "parent");
  const outer = { top: null as unknown };
  outer.top = outer;
  Object.defineProperty(window, "top", { value: outer, configurable: true });
  Object.defineProperty(window, "parent", { value: outer, configurable: true });
  try {
    const inFrame = targetingOf(field);
    expect(inFrame.frame).toEqual({
      url: "https://crm.example.test/contacts",
      path: ["iframe"],
    });
    expect(inFrame.page).toBeUndefined();
  } finally {
    if (top) Object.defineProperty(window, "top", top);
    if (parent) Object.defineProperty(window, "parent", parent);
  }
});

test("the collector's click and edits become steps with their targeting, masked: a click, a choice, a box ticked and a password", () => {
  document.title = "New contact";
  document.body.innerHTML = `
    <form>
      <button id="add" data-testid="add-contact" type="button">Add contact</button>
      <label for="stage">Stage</label>
      <select id="stage"><option value="lead">Lead</option><option value="customer">Customer</option></select>
      <label><input id="vip" type="checkbox" name="vip"> VIP</label>
      <label for="pw">Password</label><input id="pw" type="password" name="password">
    </form>`;
  const sent: CapturedEvent[] = [];
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  cleanups.push(tracker.install());
  const capture = startEventCapture({
    tracker,
    send: (event) => sent.push(event),
  });
  cleanups.push(capture.stop);
  $("#add").dispatchEvent(
    trusted(new MouseEvent("click", { bubbles: true, composed: true })),
  );
  const stage = $("#stage") as HTMLSelectElement;
  stage.value = "customer";
  stage.dispatchEvent(
    trusted(new Event("change", { bubbles: true, composed: true })),
  );
  const vip = $("#vip") as HTMLInputElement;
  vip.checked = true;
  vip.dispatchEvent(
    trusted(new Event("change", { bubbles: true, composed: true })),
  );
  const pw = $("#pw") as HTMLInputElement;
  pw.value = "Hunter-Two-99";
  pw.dispatchEvent(
    trusted(new Event("change", { bubbles: true, composed: true })),
  );
  expect(
    sent.map((event) => [event.name, (event.value as { step: string }).step]),
  ).toEqual([
    ["click", "click"],
    ["input", "select"],
    ["input", "check"],
    ["input", "change"],
  ]);
  expect(sent[0]?.value).toMatchObject({
    target: { tag: "button", role: "button", name: "Add contact" },
    page: { url: "https://crm.example.test/contacts", title: "New contact" },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    box: { x: 0, y: 0, width: 0, height: 0 },
  });
  expect(
    (
      sent[0]?.value as
        | { selectors?: { by: string; selector: string }[] }
        | undefined
    )?.selectors,
  ).toEqual([
    { by: "testid", selector: '[data-testid="add-contact"]' },
    { by: "id", selector: "#add" },
    { by: "role", selector: 'role=button[name="Add contact"]' },
    { by: "text", selector: 'text="Add contact"' },
    { by: "css", selector: "html > body > form > button" },
  ]);
  expect(sent[1]?.value).toMatchObject({
    target: {
      role: "combobox",
      name: "Stage",
      inputType: "select-one",
      value: "customer",
    },
  });
  expect(sent[2]?.value).toMatchObject({
    target: {
      role: "checkbox",
      name: "VIP",
      inputType: "checkbox",
      checked: true,
    },
  });
  expect(sent[3]?.value).toMatchObject({
    target: {
      role: "textbox",
      name: "Password",
      inputType: "password",
      value: "[redacted]",
    },
  });
  expect(leakedSecrets(sent, ["Hunter-Two-99"])).toEqual([]);
});

/** Starts the collector's step capture and clicks `element` as a person would; the step it records. */
function clickStep(element: HTMLElement): Record<string, unknown> {
  const sent: CapturedEvent[] = [];
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  cleanups.push(tracker.install());
  const capture = startEventCapture({
    tracker,
    send: (event) => sent.push(event),
  });
  cleanups.push(capture.stop);
  element.dispatchEvent(
    trusted(new MouseEvent("pointerdown", { bubbles: true, composed: true })),
  );
  element.dispatchEvent(
    trusted(new MouseEvent("click", { bubbles: true, composed: true })),
  );
  const step = sent.find((event) => event.name === "click");
  if (!step) throw new Error("no click step");
  return step.value as Record<string, unknown>;
}

const boxed = (element: HTMLElement, box: Record<string, number>) =>
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => box,
  });

test("a click on the text inside a button names and selects the button, through any wrapper, and keeps the box of what was clicked", () => {
  document.body.innerHTML = `
    <button id="ask" data-testid="ask-ai"><div role="presentation"><span id="label">Ask a <b>question</b></span></div></button>
    <div role="menuitem" tabindex="0" id="crm"><svg></svg><span id="crm-text">CRM</span></div>`;
  const label = $("#label");
  boxed(label, { x: 12, y: 40, width: 80, height: 16 });
  boxed($("#ask"), { x: 0, y: 30, width: 200, height: 36 });
  const step = clickStep(label);
  expect(step.target).toMatchObject({ role: "button", name: "Ask a question" });
  expect(step.selectors).toEqual([
    { by: "testid", selector: '[data-testid="ask-ai"]' },
    { by: "id", selector: "#ask" },
    { by: "role", selector: 'role=button[name="Ask a question"]' },
    { by: "text", selector: 'text="Ask a question"' },
    { by: "css", selector: "html > body > button" },
  ]);
  expect(step.box).toEqual({ x: 12, y: 40, width: 80, height: 16 });
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
  const crm = clickStep($("#crm-text"));
  expect(crm.target).toMatchObject({ role: "menuitem", name: "CRM" });
  expect((crm.selectors as { by: string; selector: string }[])[0]).toEqual({
    by: "id",
    selector: "#crm",
  });
});

test("a click that meets nothing a person acts on names the clicked element by its own first 60 characters, its pieces of text kept apart", () => {
  document.body.innerHTML = `
    <div id="panel" class="TFlex__StyledFlex-inKyeJ edqmbC">
      <h1>Sign in</h1><p>or create an account</p><a href="/google">Sign in with Google</a><p>See how we can help you grow.</p>
    </div>
    <ul id="nav" role="menu"><li>Bookmarks</li><li>CRM</li><li>Marketing</li><li>Content</li><li>Sales</li><li>Revenue</li><li>Service</li></ul>`;
  const panel = clickStep($("#panel"));
  // Cut at 60 characters, at most.
  expect((panel.target as { name: string }).name).toBe(
    "Sign in or create an account Sign in with Google See how we",
  );
  expect((panel.selectors as { by: string }[]).map((s) => s.by)).toEqual([
    "id",
    "css",
  ]);
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
  const menu = clickStep($("#nav"));
  expect(menu.target).toMatchObject({
    role: "menu",
    name: "Bookmarks CRM Marketing Content Sales Revenue Service",
  });
});

test("text split across elements is never glued into one word in a name", () => {
  document.body.innerHTML = `
    <a id="a" href="/x"><span>Sign</span><span>in</span></a>
    <button id="b"><b>Save</b>changes</button>
    <button id="c">Close <span hidden>dialog 4921</span><span aria-hidden="true">x</span></button>`;
  expect(nameOf($("#a"))).toBe("Sign in");
  expect(nameOf($("#b"))).toBe("Save changes");
  expect(nameOf($("#c"))).toBe("Close");
});
