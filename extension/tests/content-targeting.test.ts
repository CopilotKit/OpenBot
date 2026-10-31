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

test("selectors come in the order Playwright's generator scores them: test attribute, role and name, text, hand-made id, name, then a short CSS path from a stable ancestor", () => {
  document.body.innerHTML = `
    <div data-testid="contact-card"><div><span>
      <button id="save-contact" name="save" data-testid="save-contact" class="x6s0dn4 xrvj5dj">Save</button>
      <button id=":r7:" class="sc-kcGFou diMWFu">Cancel</button>
    </span></div></div>`;
  const save = $('[data-testid="save-contact"]');
  expect(selectorsOf(save, "button", "Save", () => false)).toEqual([
    { by: "testid", selector: '[data-testid="save-contact"]' },
    { by: "role", selector: 'role=button[name="Save"]' },
    { by: "text", selector: 'text="Save"' },
    { by: "id", selector: "#save-contact" },
    { by: "name", selector: 'button[name="save"]' },
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

test("a selector that also finds another element ranks after every one that finds this one alone, as Playwright penalises it", () => {
  // Two rows each with a Delete button and the same test id: role and name, text and the test id find both.
  document.body.innerHTML = `
    <ul id="contacts">
      <li><span>Ada</span><button data-testid="row-delete" id="delete-ada">Delete</button></li>
      <li><span>Grace</span><button data-testid="row-delete">Delete</button></li>
    </ul>`;
  const ada = $("#delete-ada");
  expect(selectorsOf(ada, "button", "Delete", () => false)).toEqual([
    { by: "id", selector: "#delete-ada" },
    { by: "testid", selector: '[data-testid="row-delete"]' },
    { by: "role", selector: 'role=button[name="Delete"]' },
    { by: "text", selector: 'text="Delete"' },
    { by: "css", selector: "#contacts > li:nth-of-type(1) > button" },
  ]);
});

test("Wikipedia's generated ids are never a selector: run 2's click on Charles Babbage leads with its role and name, not #mwGQ", () => {
  // Ada Lovelace's article as Wikipedia serves it (Parsoid gives every element an `mw` id counted in base 64), clicked in
  // end-to-end run 2, row 89043: its selectors led with #mwGQ and its CSS path hung off #mwEw.
  document.title = "Ada Lovelace - Wikipedia";
  document.body.innerHTML = `
    <div id="mw-content-text" class="mw-body-content"><div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
      <p id="mwEw">Lovelace became close friends with her tutor <a rel="mw:WikiLink" href="/wiki/Mary_Somerville" title="Mary Somerville" id="mwGA">Mary Somerville</a>, who introduced her to <a rel="mw:WikiLink" href="/wiki/Charles_Babbage" title="Charles Babbage" id="mwGQ">Charles Babbage</a> in 1833.</p>
    </div></div>`;
  for (const id of ["mwGQ", "mwEw", "mwAQ", "mwBA"])
    expect([id, isGeneratedId(id)]).toEqual([id, true]);
  for (const id of ["mw-content-text", "searchInput", "mce_0_ifr"])
    expect([id, isGeneratedId(id)]).toEqual([id, false]);
  const link = $("#mwGQ");
  const targeting = targetingOf(link);
  expect(targeting).toMatchObject({
    ariaRole: "link",
    name: "Charles Babbage",
  });
  expect(targeting.selectors).toEqual([
    { by: "role", selector: 'role=link[name="Charles Babbage"]' },
    { by: "text", selector: 'text="Charles Babbage"' },
    { by: "href", selector: 'a[href="/wiki/Charles_Babbage"]' },
    {
      by: "css",
      selector: "#mw-content-text > div > p > a:nth-of-type(2)",
    },
  ]);
  expect(JSON.stringify(targeting.selectors)).not.toContain("mwGQ");
  expect(JSON.stringify(targeting.selectors)).not.toContain("mwEw");
});

test("OpenBot's new-chat link, an icon with no name, is found by its address before its position; a volatile address never is", () => {
  // The sidebar header as OpenBot renders it (app-sidebar.tsx: a Base UI Button rendered as the router's Link to
  // /channel/new, holding Tabler's IconPlus with no title), clicked in the CopilotKit-site end-to-end run 3, row 044:
  // its one selector was its position.
  document.body.innerHTML = `
    <div data-slot="sidebar-wrapper"><div data-slot="sidebar"><div data-slot="sidebar-container"><div data-slot="sidebar-inner"><div data-slot="sidebar-header" class="h-12 p-2"><ul data-slot="sidebar-menu"><li data-slot="sidebar-menu-item" class="flex flex-row gap-1.5"><a data-slot="sidebar-menu-button" href="/">OpenBot</a><a href="/channel/new" role="button" class="group/button inline-flex shrink-0 items-center size-8" tabindex="0" data-slot="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tabler-icon tabler-icon-plus "><path d="M12 5l0 14"></path><path d="M5 12l14 0"></path></svg></a></li></ul></div><div data-slot="sidebar-content"></div><div data-slot="sidebar-footer"></div></div></div></div></div>
    <a id="invite" href="/join/2f9c41d07a1b4e6f8c3d5a7b9e1f0c2d?token=a8f3k2l9q">Join</a>
    <p><a id="refund" href="/checkout?order=1043">Refund this order</a></p>`;
  const plus = $('a[href="/channel/new"]');
  const targeting = targetingOf(plus);
  expect(targeting.selectors).toEqual([
    { by: "href", selector: 'a[href="/channel/new"]' },
    {
      by: "css",
      selector: "div > div:nth-of-type(1) > ul > li > a:nth-of-type(2)",
    },
  ]);
  // The page gives the link no aria-label, no title and no text: it has no name to record.
  expect(targeting).toMatchObject({ ariaRole: "button", name: "" });
  // An address with a session or a random part in it changes from one visit to the next; an order number does not.
  expect(
    targetingOf($("#invite")).selectors.map((selector) => selector.by),
  ).toEqual(["role", "text", "id", "css"]);
  expect(targetingOf($("#refund")).selectors).toEqual([
    { by: "role", selector: 'role=link[name="Refund this order"]' },
    { by: "text", selector: 'text="Refund this order"' },
    { by: "id", selector: "#refund" },
    { by: "href", selector: 'a[href="/checkout?order=1043"]' },
    { by: "css", selector: "html > body > p > a" },
  ]);
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
    ariaRole: "textbox",
    name: "Email",
    inputType: "email",
    box: { x: 10, y: 21, width: 300, height: 32 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: { url: "https://crm.example.test/contacts", title: "Contacts" },
  });
  const inFrame = inCrossSiteFrame([], () => targetingOf(field));
  expect(inFrame.frame).toEqual({
    url: "https://crm.example.test/contacts",
    path: ['iframe[src*="//crm.example.test/contacts"]'],
  });
  expect(inFrame.page).toBeUndefined();
});

type FakeWindow = {
  frames: unknown[];
  length: number;
  top: unknown;
  parent: unknown;
  readonly frameElement: Element | null;
  readonly location: { host: string; pathname: string };
};

/** A window of another site, as a frame's script sees it in Chrome: its frames and their number can be read, its
 * location and its iframe element cannot (SecurityError). `children` are its frames, in its document's order. */
function crossSiteWindow(children: unknown[]): FakeWindow {
  const blocked = () => {
    throw new DOMException(
      "Blocked a frame from accessing a cross-origin frame.",
      "SecurityError",
    );
  };
  const fake = {
    frames: children,
    length: children.length,
    top: null as unknown,
    parent: null as unknown,
  } as FakeWindow;
  Object.defineProperty(fake, "frameElement", { get: blocked });
  Object.defineProperty(fake, "location", { get: blocked });
  fake.top = fake;
  fake.parent = fake;
  return fake;
}

/** A frame of this frame's own site: its location can be read. */
const sameSiteWindow = (href: string) => {
  const url = new URL(href);
  return { location: { host: url.host, pathname: url.pathname } };
};

/** Runs `fn` with this page as a frame of a cross-site parent whose frames are `siblings` with this window among them
 * (at `at`, last by default), and the parent itself a frame of `grandparent` when one is given. */
function inCrossSiteFrame<T>(
  siblings: unknown[],
  fn: () => T,
  options: { at?: number; name?: string; grandparent?: FakeWindow } = {},
): T {
  const frames = [...siblings];
  frames.splice(options.at ?? frames.length, 0, window);
  const parent = crossSiteWindow(frames);
  if (options.grandparent) {
    options.grandparent.frames.push(parent);
    options.grandparent.length = options.grandparent.frames.length;
    parent.parent = options.grandparent;
    parent.top = options.grandparent;
  }
  const saved = ["top", "parent", "frameElement"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(window, key)] as const,
  );
  const name = window.name;
  Object.defineProperty(window, "top", {
    value: parent.top,
    configurable: true,
  });
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
  // Chrome's frameElement is null for a frame whose parent is another site.
  Object.defineProperty(window, "frameElement", {
    value: null,
    configurable: true,
  });
  window.name = options.name ?? "";
  try {
    return fn();
  } finally {
    window.name = name;
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else delete (window as unknown as Record<string, unknown>)[key];
  }
}

test("a field in a cross-site iframe names that iframe: by its name, else the address it loaded and which of the frames loading it, and an iframe further up by its position", () => {
  // The shop's address page of end-to-end run 1: a same-site iframe (#same) and the courier's form from another site
  // ([::1]), whose steps recorded their frame as just ["iframe"].
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL("http://[::1]:7420/frame/courier");
  document.body.innerHTML = `<form id="cour"><label for="slot">Delivery slot</label><select id="slot"><option value="am">Morning</option><option value="pm">Afternoon</option></select></form>`;
  const slot = $("#slot");
  const sameSite = crossSiteWindow([]);
  const pathOf = (
    siblings: unknown[],
    options?: Parameters<typeof inCrossSiteFrame>[2],
  ) => inCrossSiteFrame(siblings, () => targetingOf(slot).frame, options);
  expect(pathOf([sameSite])).toEqual({
    url: "http://[::1]:7420/frame/courier",
    path: ['iframe[src*="//[::1]:7420/frame/courier"]'],
  });
  // Two courier forms on the page: which one, counting the frames that load the same address from 0.
  expect(
    pathOf([sameSite, sameSiteWindow("http://[::1]:7420/frame/courier")])?.path,
  ).toEqual(['iframe[src*="//[::1]:7420/frame/courier"] >> nth=1']);
  expect(
    pathOf([sameSite, sameSiteWindow("http://[::1]:7420/frame/courier")], {
      at: 1,
    })?.path,
  ).toEqual(['iframe[src*="//[::1]:7420/frame/courier"] >> nth=0']);
  // The name the iframe gave its frame is the steadiest handle.
  expect(pathOf([sameSite], { name: "courier" })?.path).toEqual([
    'iframe[name="courier"]',
  ]);
  // Inside a cross-site frame that is itself the third frame of a cross-site page.
  const top = crossSiteWindow([crossSiteWindow([]), crossSiteWindow([])]);
  expect(pathOf([sameSite], { grandparent: top })?.path).toEqual([
    "iframe >> nth=2",
    'iframe[src*="//[::1]:7420/frame/courier"]',
  ]);
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL("https://crm.example.test/contacts");
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
    // CopilotKit's role is the role attribute (none here); the Recorder's computed role sits beside it.
    target: {
      tag: "button",
      role: null,
      ariaRole: "button",
      name: "Add contact",
    },
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
    { by: "role", selector: 'role=button[name="Add contact"]' },
    { by: "text", selector: 'text="Add contact"' },
    { by: "id", selector: "#add" },
    { by: "css", selector: "html > body > form > button" },
  ]);
  expect(sent[1]?.value).toMatchObject({
    target: {
      role: null,
      ariaRole: "combobox",
      name: "Stage",
      inputType: "select-one",
      value: "customer",
    },
  });
  expect(sent[2]?.value).toMatchObject({
    target: {
      role: null,
      ariaRole: "checkbox",
      name: "VIP",
      inputType: "checkbox",
      checked: true,
    },
  });
  expect(sent[3]?.value).toMatchObject({
    target: {
      role: null,
      ariaRole: "textbox",
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
  // CopilotKit's own target (the presentation wrapper it described, by its role attribute) stays as it wrote it.
  expect(step.target).toMatchObject({
    role: "presentation",
    ariaRole: "button",
    name: "Ask a question",
  });
  expect(step.selectors).toEqual([
    { by: "testid", selector: '[data-testid="ask-ai"]' },
    { by: "role", selector: 'role=button[name="Ask a question"]' },
    { by: "text", selector: 'text="Ask a question"' },
    { by: "id", selector: "#ask" },
    { by: "css", selector: "html > body > button" },
  ]);
  expect(step.box).toEqual({ x: 12, y: 40, width: 80, height: 16 });
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
  const crm = clickStep($("#crm-text"));
  expect(crm.target).toMatchObject({ ariaRole: "menuitem", name: "CRM" });
  expect((crm.selectors as { by: string; selector: string }[])[0]).toEqual({
    by: "role",
    selector: 'role=menuitem[name="CRM"]',
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
    ariaRole: "menu",
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
