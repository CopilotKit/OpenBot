// The secrets the full end-to-end run typed, end to end through the Recorder's own code, on the pages its fixture shop
// served (the Corner Shop admin, `.agui-e2e/e2e-full-nocpk/shop.ts`) and with the run's own values. The content script runs
// in happy-dom as content/index.ts runs it (the sensitivity tracker, then CopilotKit's capture and the submit and Enter
// capture), one document per page; what it posts on its port is handed, in order, to the real service worker (the
// recording, the steps, the agent events and the masking), whose messages to the offscreen document are what reaches
// Intelligence. The network capture inside the worker is the real one, on the fake debugger.
//
// In the run, the admin password typed on /checkout came back on /account, typed and pasted into two ordinary fields, as
// the person typed it: each content script knows only its own document's secrets. And two one-time codes, typed into
// fields that say only that the code was texted or sent to the phone, reached Intelligence in the edit and in the save.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type CapturedEvent,
  REDACTED,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import {
  createNetworkCapture,
  type NetworkCaptureDeps,
} from "../src/background/network";
import {
  installRecording,
  type RecordingDeps,
} from "../src/background/recording";
import { installRouter } from "../src/background/router";
import type { StepCall } from "../src/background/steps";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import {
  type BackgroundToOffscreen,
  type ContentToBackground,
  type PageResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
} from "../src/protocol/messages";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";
import { leakedSecrets } from "./support/recorded-text";

const SHOP = "http://127.0.0.1:7420";
/** The run's admin password and one-time codes (run-shop.ts). */
const PASSWORD = "Kestrel-Pw-58213!";
const CARD = "4929731128465036";
const OTP_A = "739214";
const OTP_B = "582046";
const OTP_B2 = "315827";
const BOXES = "164903";
const CODES = [OTP_A, OTP_B, OTP_B2, BOXES];

// ---- The shop's pages, as it served them (scripts aside: the person's own actions drive them here) ----------------------

const CHECKOUT = `<form id="refund-form">
<label for="full-name">Name on the refund</label><input id="full-name" name="fullName" autocomplete="name">
<label for="reason">Reason</label><textarea id="reason" name="reason"></textarea>
<label for="admin-password">Your admin password</label><input id="admin-password" name="password" type="password" autocomplete="current-password">
<label for="card-number">Card number</label><div id="card-root"><input id="card-number" name="cardnumber" inputmode="numeric" value=""></div>
<label for="notes">Notes for the team</label><textarea id="notes" name="notes"></textarea>
<label for="ref">Reference for the customer</label><input id="ref" name="reference">
<button id="pay" type="submit">Send refund</button>
</form><pre id="result"></pre>`;

const ACCOUNT = `<form id="account" method="post" action="/api/account/update">
<label for="display-name">Display name</label><input id="display-name" name="displayName" value="Shop Admin">
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="">
<label for="support-note">Note to support</label><input id="support-note" name="supportNote">
<label for="memo">Internal memo</label><input id="memo" name="memo">
<button type="submit" class="ghost">Save account</button>
</form><pre id="acct"></pre>`;

const SECURITY = `<form id="otp-a"><label for="totp">Code from your authenticator app</label><input id="totp" autocomplete="one-time-code" inputmode="numeric"><button type="submit">Verify app</button></form><pre id="ra"></pre>
<form id="otp-b"><label for="sms">Enter the code we texted you</label><input id="sms" type="text"><button type="submit">Confirm phone</button></form><pre id="rb"></pre>
<form id="otp-b2"><label for="pc">Enter what we sent to your phone</label><input id="pc" type="text"><button type="submit">Confirm number</button></form><pre id="rb2"></pre>
<form id="otp-c"><p style="font-weight:500;margin:14px 0 4px">Backup sign-in</p><div class="row boxes">${[
  1, 2, 3, 4, 5, 6,
]
  .map(
    (i) =>
      `<input data-box="${i}" maxlength="1" inputmode="numeric" aria-label="Digit ${i}">`,
  )
  .join(
    "",
  )}</div><button type="submit">Use backup</button></form><pre id="rc"></pre>`;

// ---- The content script, one document per page -----------------------------------------------------------------------

type PortMessage = Extract<
  ContentToBackground,
  { type: "content.event" | "content.sensitive" }
>;

/** happy-dom cannot make a trusted event; the capture records only trusted ones, as Chrome's are. */
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

/** A page's address: a path on the shop, or a whole address on another site. */
const addressOf = (path: string) =>
  /^https?:/.test(path) ? path : `${SHOP}${path}`;

/** One document of the shop with the content script capturing in it, wired as content/index.ts wires it: the tracker's
 * digests and the capture's events go out on the one port, in order. */
function openPage(path: string, title: string, markup: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(addressOf(path));
  document.title = `${title} - Corner Shop admin`;
  document.body.innerHTML = markup;
  const posted: PortMessage[] = [];
  const tracker = createSensitivityTracker();
  const uninstall = tracker.install();
  tracker.onSensitiveValue((digest) =>
    posted.push({ type: "content.sensitive", digest }),
  );
  const capture = startEventCapture({
    tracker,
    send: (event) => posted.push({ type: "content.event", event }),
  });
  return {
    posted,
    /** The person leaves the page: what the capture holds goes, and the document's script with it. */
    leave() {
      capture.stop();
      uninstall();
    },
  };
}

const field = (selector: string) => {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement))
    throw new Error(`No ${selector} on the page`);
  return element;
};

/** A pointer click, as Chrome fires one on a field: pointerdown, focus, click. */
function click(selector: string) {
  const element = field(selector);
  element.dispatchEvent(
    trusted(new PointerEvent("pointerdown", { bubbles: true, composed: true })),
  );
  element.focus();
  element.dispatchEvent(
    trusted(new FocusEvent("focusin", { bubbles: true, composed: true })),
  );
  element.dispatchEvent(
    trusted(
      new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
    ),
  );
}

const input = (element: HTMLElement) =>
  element.dispatchEvent(
    trusted(new Event("input", { bubbles: true, composed: true })),
  );

/** Keystroke by keystroke, as Playwright's keyboard.type typed it in the run: an input event per character. */
function type(selector: string, text: string) {
  const element = field(selector) as HTMLInputElement | HTMLTextAreaElement;
  for (const character of text) {
    element.value += character;
    input(element);
  }
}

/** All of it in one input event, as a paste (CDP's Input.insertText in the run) lands. */
function paste(selector: string, text: string) {
  const element = field(selector) as HTMLInputElement;
  element.value += text;
  input(element);
}

/** Enter in a field of a form: the keydown, then the submit the browser fires for it. */
function pressEnter(selector: string) {
  const element = field(selector) as HTMLInputElement;
  element.dispatchEvent(
    trusted(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        composed: true,
      }),
    ),
  );
  element.form?.dispatchEvent(
    trusted(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

/** A click on a form's submit button, and the submit it makes. */
function submitWith(buttonText: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === buttonText,
  );
  if (!button) throw new Error(`No ${buttonText} button`);
  button.dispatchEvent(
    trusted(new PointerEvent("pointerdown", { bubbles: true, composed: true })),
  );
  button.dispatchEvent(
    trusted(
      new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
    ),
  );
  const submit = trusted(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  Object.defineProperty(submit, "submitter", { value: button });
  button.form?.dispatchEvent(submit);
}

/** Runs the person's steps on the shop's pages in a browser of their own, and hands back each page's port messages. */
function browse<T>(work: () => T): T {
  GlobalRegistrator.register({ url: SHOP });
  try {
    return work();
  } finally {
    void GlobalRegistrator.unregister();
  }
}

// ---- The service worker ------------------------------------------------------------------------------------------

const EXTENSION_ID = "test";
let fake: ChromeFake | null = null;
let doc: { messages: unknown[] } | null = null;
/** Every call the real network capture handed the steps, masked. */
let calls: StepCall[] = [];
let networkDeps: NetworkCaptureDeps | null = null;

afterEach(() => {
  fake?.uninstall();
  fake = null;
  doc = null;
  calls = [];
  responses = {};
  networkDeps = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await sleep(5);
  }
}

/** The real worker, its network capture the real one (watched), recording tab 7 from `firstPage`. Its clock is a minute
 * past the person's steps, so each step leaves as soon as the next arrives. */
async function recordInWorker(firstPage: string) {
  const installed = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake = installed;
  installed.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(() => {
      const port = installed.connectFrom(PORT_OFFSCREEN, {
        id: EXTENSION_ID,
        url: `chrome-extension://${EXTENSION_ID}/offscreen.html`,
      });
      doc = port;
      port.postMessage({ type: "offscreen.ready" });
    }, 0);
  });
  installed.storage.local.set("connection", {
    openbotUrl: "http://127.0.0.1:9",
    token: "obr_one",
    connectionId: "c-obr_one",
    user: { id: "p1", name: "Ada", email: "ada@example.test" },
    via: "web",
    connectedAt: Date.now(),
  });
  installed.debugger.respond("Network.getResponseBody", (params) => {
    const body = responses[(params as { requestId: string }).requestId];
    if (body === undefined)
      throw new Error("No resource with given identifier found");
    return { body, base64Encoded: false };
  });
  const now = Date.now() + 60_000;
  const deps: Partial<RecordingDeps> = {
    createNetworkCapture: (captureDeps, options) => {
      networkDeps = captureDeps;
      return createNetworkCapture(
        {
          ...captureDeps,
          call: (call) => {
            calls.push(call);
            captureDeps.call(call);
          },
        },
        options,
      );
    },
    createPageFallback: () => ({
      start: async () => false,
      addTab: async () => {},
      onCommitted: async () => {},
      stop: async () => {},
      active: () => false,
    }),
    readPolicy: async () => ({
      openbotUrl: null,
      openbotUrlInvalid: false,
      allowedIntelligenceUrls: null,
    }),
    hasHostPermission: async () => true,
    now: () => now,
    timers: { set: () => 0, clear: () => {} },
  };
  installRouter(installRecording(deps));
  installed.tabs.set(7, {
    id: 7,
    url: `${SHOP}${firstPage}`,
    title: "Corner Shop admin",
  } as chrome.tabs.Tab);
  const answer = (await installed.sendFromPage({
    type: "page.record",
    title: "Refund order 1043 for a damaged parcel",
    tabId: 7,
  })) as PageResponse;
  expect(answer).toEqual({ ok: true });
  await until(() => doc !== null, "the document");
}

/** A page's port messages, posted by its own content script's port in the order it posted them. */
function postFromPage(
  messages: PortMessage[],
  path: string,
  where: { tabId?: number; frameId?: number } = {},
) {
  if (!fake) throw new Error("No worker");
  const port = fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: where.tabId ?? 7 } as chrome.tabs.Tab,
    frameId: where.frameId ?? 0,
    url: addressOf(path),
  });
  for (const message of messages) port.postMessage(message);
}

/** The checkout page's messages have reached the worker: the person moves on seconds later, as in the run. */
const passwordKnown = () =>
  until(
    () => networkDeps?.digests().has(sha256HexSync(PASSWORD)) ?? false,
    "the password's digest in the worker",
  );

/** What the worker sent the offscreen document to stream to Intelligence. */
const streamed = (): CapturedEvent[] =>
  ((doc?.messages ?? []) as BackgroundToOffscreen[]).flatMap((message) =>
    message.type === "offscreen.event" ? [message.event] : [],
  );
const edits = () =>
  streamed()
    .filter((event) => event.name === "input")
    .map(
      (event) =>
        (event.value as { target: { attributes: { id?: string } } }).target,
    ) as unknown as Array<{
    value?: string;
    name?: string;
    attributes: Record<string, string>;
  }>;

/** The debugger's bodies for Network.getResponseBody, by request id. */
let responses: Record<string, string> = {};

/** A POST the page sent, as Chrome's debugger reports it: `at` is its start on the person's clock, in milliseconds. A
 * JSON fetch answered 200 unless the spec says otherwise. */
function debuggerPost(spec: {
  id: string;
  url: string;
  at: number;
  postData: string;
  body: string;
  type?: string;
  headers?: Record<string, string>;
  status?: number;
  responseHeaders?: Record<string, string>;
}) {
  if (!fake) throw new Error("No worker");
  responses[spec.id] = spec.body;
  const target = { tabId: 7 };
  const seconds = spec.at / 1000;
  const type = spec.type ?? "Fetch";
  fake.debugger.emit(target, "Network.requestWillBeSent", {
    requestId: spec.id,
    type,
    timestamp: 100,
    wallTime: seconds,
    request: {
      url: spec.url,
      method: "POST",
      headers: spec.headers ?? { "content-type": "application/json" },
      postData: spec.postData,
    },
  });
  fake.debugger.emit(target, "Network.responseReceived", {
    requestId: spec.id,
    type,
    timestamp: 100.04,
    response: {
      url: spec.url,
      status: spec.status ?? 200,
      headers: spec.responseHeaders ?? { "content-type": "application/json" },
      mimeType: "application/json",
    },
  });
  fake.debugger.emit(target, "Network.loadingFinished", {
    requestId: spec.id,
    timestamp: 100.05,
  });
}

// ---- A password typed on one page, then on the next --------------------------------------------------------------

/** The run's checkout, then its account page, in one tab: every step as run-shop.ts took it. */
function checkoutThenAccount() {
  return browse(() => {
    const checkout = openPage(
      "/checkout?order=1043",
      "Refund to card",
      CHECKOUT,
    );
    click("#full-name");
    type("#full-name", "Grace Hopper");
    click("#reason");
    type("#reason", "Parcel arrived damaged");
    click("#admin-password");
    type("#admin-password", PASSWORD);
    click("#card-number");
    type("#card-number", CARD);
    click("#notes");
    type("#notes", `checked with ${PASSWORD} ok`);
    click("#ref");
    paste("#ref", PASSWORD);
    submitWith("Send refund");
    checkout.leave();

    const account = openPage("/account", "Account", ACCOUNT);
    click("#display-name");
    (field("#display-name") as HTMLInputElement).value = "";
    type("#display-name", "Corner Shop Admin");
    click("#support-note");
    type("#support-note", `pw is ${PASSWORD}`);
    click("#memo");
    paste("#memo", PASSWORD);
    pressEnter("#memo");
    account.leave();
    return { checkout: checkout.posted, account: account.posted };
  });
}

test("the admin password typed on checkout, then typed and pasted into ordinary fields on the account page, never reaches Intelligence", async () => {
  const pages = checkoutThenAccount();
  // The account page's own script never saw the password typed into a sensitive field: it sends it as typed.
  expect(
    pages.account.some((message) => message.type === "content.sensitive"),
  ).toBe(false);

  await recordInWorker("/checkout?order=1043");
  postFromPage(pages.checkout, "/checkout?order=1043");
  await passwordKnown();
  fake?.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: `${SHOP}/account`,
    transitionType: "link",
  });
  postFromPage(pages.account, "/account");
  await until(
    () => edits().filter((edit) => edit.attributes.id === "memo").length === 1,
    "the memo's edit",
  );

  expect(leakedSecrets(streamed(), [PASSWORD])).toEqual([]);
  const byField = Object.fromEntries(
    edits().map((edit) => [edit.attributes.id, edit.value]),
  );
  expect(byField).toMatchObject({
    // The run's rows ...8050 and ...8052, now masked.
    "support-note": `pw is ${REDACTED}`,
    memo: REDACTED,
    // On the checkout page itself, as before.
    "admin-password": REDACTED,
    notes: `checked with ${REDACTED} ok`,
    ref: REDACTED,
    // What is no secret is kept as typed.
    "full-name": "Grace Hopper",
    reason: "Parcel arrived damaged",
    "display-name": "Corner Shop Admin",
  });
  // The fields are still named and found as the page drew them.
  expect(
    edits().find((edit) => edit.attributes.id === "support-note")?.name,
  ).toBe("Note to support");
});

test("the password typed on checkout is masked on the account page in another tab, and in a frame", async () => {
  const pages = checkoutThenAccount();
  await recordInWorker("/checkout?order=1043");
  postFromPage(pages.checkout, "/checkout?order=1043");
  await passwordKnown();
  // The person opened the account page in a new tab from the checkout tab, inside a frame of it.
  fake?.webNavigation.createdTarget({
    sourceTabId: 7,
    tabId: 8,
    url: `${SHOP}/account`,
  });
  fake?.tabs.set(8, {
    id: 8,
    url: `${SHOP}/account`,
    title: "Account - Corner Shop admin",
  } as chrome.tabs.Tab);
  await sleep(20);
  postFromPage(pages.account, "/account", { tabId: 8, frameId: 3 });
  await until(
    () => edits().filter((edit) => edit.attributes.id === "memo").length === 1,
    "the memo's edit",
  );
  expect(leakedSecrets(streamed(), [PASSWORD])).toEqual([]);
  expect(
    edits().find((edit) => edit.attributes.id === "support-note")?.value,
  ).toBe(`pw is ${REDACTED}`);
});

test("the password typed on checkout, searched for on the shop's home page, is masked in the page change's address", async () => {
  const pages = checkoutThenAccount();
  await recordInWorker("/checkout?order=1043");
  postFromPage(pages.checkout, "/checkout?order=1043");
  await passwordKnown();
  // The home page's order search (Enter in "Search orders") goes to /search?q=..., the address the tab then commits.
  const search = `${SHOP}/search?q=${encodeURIComponent(PASSWORD)}`;
  fake?.tabs.set(7, {
    id: 7,
    url: search,
    title: "Search - Corner Shop admin",
  } as chrome.tabs.Tab);
  fake?.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: search,
    transitionType: "form_submit",
  });
  // The person moves to another tab: the search page they arrived on, with no step there, goes out.
  fake?.person.openTab();
  const changes = () =>
    streamed().filter(
      (event) =>
        event.name === "navigation" &&
        String((event.value as { to?: string }).to).includes("/search"),
    );
  await until(() => changes().length === 1, "the page change");
  expect(leakedSecrets(changes(), [PASSWORD, "Kestrel"])).toEqual([]);
  expect((changes()[0]?.value as { to?: string } | undefined)?.to).toBe(
    `${SHOP}/search?q=${REDACTED}`,
  );
});

// ---- One-time codes in fields that only say the code was sent ----------------------------------------------------

/** The run's security page: the four codes, each submitted as run-shop.ts did. */
function securityPage() {
  return browse(() => {
    const page = openPage("/security", "Security", SECURITY);
    click("#totp");
    type("#totp", OTP_A);
    pressEnter("#totp");
    click("#sms");
    type("#sms", OTP_B);
    submitWith("Confirm phone");
    click("#pc");
    type("#pc", OTP_B2);
    submitWith("Confirm number");
    click('[data-box="1"]');
    [...BOXES].forEach((digit, index) => {
      // The page moves focus to the next box as each is filled.
      const box = field(`[data-box="${index + 1}"]`) as HTMLInputElement;
      box.focus();
      box.value = digit;
      input(box);
    });
    submitWith("Use backup");
    page.leave();
    return page.posted;
  });
}

test("the codes typed into the fields that say they were texted or sent to the phone never leave the page, and their digests go to the worker", () => {
  const posted = securityPage();
  const events = posted.flatMap((message) =>
    message.type === "content.event" ? [message.event] : [],
  );
  expect(leakedSecrets(events, CODES)).toEqual([]);
  const typed = events
    .filter((event) => event.name === "input")
    .map((event) => (event.value as { target: { value?: string } }).target);
  expect(typed.length).toBeGreaterThanOrEqual(4);
  for (const target of typed) expect(target.value).toBe(REDACTED);
  // Each code's digest is posted, so the worker masks it in everything after.
  const digests = posted.flatMap((message) =>
    message.type === "content.sensitive" ? [message.digest] : [],
  );
  for (const code of CODES) expect(digests).toContain(sha256HexSync(code));
});

test("the code sent to the phone is masked in the save's body and in its answer, by the digest the page's script posted", async () => {
  const posted = securityPage();
  await recordInWorker("/security");
  postFromPage(posted, "/security");
  await until(
    () => networkDeps?.digests().has(sha256HexSync(OTP_B2)) ?? false,
    "the code's digest in the worker",
  );
  // The page's save of the code, with the run's own body and answer (shop.ts /api/phone/confirm).
  debuggerPost({
    id: "confirm",
    url: `${SHOP}/api/phone/confirm`,
    at: Date.now(),
    postData: JSON.stringify({
      phoneNumber: "+44 7700 900123",
      entered: OTP_B2,
    }),
    body: JSON.stringify({
      verified: true,
      echo: { phoneNumber: "+44 7700 900123", entered: OTP_B2 },
      accessToken: "at_nocpkAccessTok00998877665544",
    }),
  });
  await until(() => calls.some((call) => call.exchange), "the save");
  const save = calls.find((call) => call.exchange)?.exchange;
  expect(leakedSecrets(save, CODES)).toEqual([]);
  expect(JSON.stringify(save)).toContain("+44 7700 900123");
  expect(leakedSecrets(streamed(), CODES)).toEqual([]);
});

test("a code a content script let through is caught in the worker, which masks its save after it", async () => {
  await recordInWorker("/security");
  // The run's row ...8080 as the content script sent it then, the code in the edit and no digest posted for it.
  const at = Date.now() - 2_000;
  postFromPage(
    [
      {
        type: "content.event",
        event: {
          type: "CUSTOM",
          name: "input",
          timestamp: at,
          value: {
            box: { x: 273, y: 611, width: 720, height: 40 },
            url: `${SHOP}/security`,
            page: {
              url: `${SHOP}/security`,
              title: "Security - Corner Shop admin",
            },
            step: "input",
            route: "/security",
            target: {
              tag: "input",
              name: "Enter what we sent to your phone",
              role: "textbox",
              text: "",
              value: OTP_B2,
              action: null,
              inputType: "text",
              attributes: { id: "pc", type: "text" },
            },
            viewport: { width: 1280, height: 860 },
            eventType: "input",
            selectors: [
              { by: "id", selector: "#pc" },
              {
                by: "role",
                selector:
                  'role=textbox[name="Enter what we sent to your phone"]',
              },
              { by: "css", selector: "#otp-b2 > input" },
            ],
          },
        },
      },
    ],
    "/security",
  );
  await until(
    () => edits().some((edit) => edit.attributes.id === "pc"),
    "the edit",
  );
  expect(edits().find((edit) => edit.attributes.id === "pc")?.value).toBe(
    REDACTED,
  );
  expect(networkDeps?.digests().has(sha256HexSync(OTP_B2))).toBe(true);
  debuggerPost({
    id: "confirm",
    url: `${SHOP}/api/phone/confirm`,
    at: Date.now(),
    postData: JSON.stringify({
      phoneNumber: "+44 7700 900123",
      entered: OTP_B2,
    }),
    body: JSON.stringify({
      verified: true,
      echo: { phoneNumber: "+44 7700 900123", entered: OTP_B2 },
      accessToken: "at_nocpkAccessTok00998877665544",
    }),
  });
  await until(() => calls.some((call) => call.exchange), "the save");
  expect(
    leakedSecrets(calls.find((call) => call.exchange)?.exchange, [OTP_B2]),
  ).toEqual([]);
});

// ---- A button or link that only names a password ------------------------------------------------------------------

/** The final run's checkout (shop.ts): the admin password with the Show password button beside it, whose click flips the
 * field's type. */
const CHECKOUT_WITH_TOGGLE = `<form id="refund-form">
<label for="full-name">Name on the refund</label><input id="full-name" name="fullName" autocomplete="name">
<label for="reason">Reason</label><textarea id="reason" name="reason"></textarea>
<label for="admin-password">Your admin password</label><input id="admin-password" name="password" type="password" autocomplete="current-password"><button type="button" id="show-pw" class="ghost" style="margin-top:6px">Show password</button>
<label for="card-number">Card number</label><div id="card-root"><input id="card-number" name="cardnumber" inputmode="numeric" value=""></div>
<label for="notes">Notes for the team</label><textarea id="notes" name="notes"></textarea>
<label for="ref">Reference for the customer</label><input id="ref" name="reference">
<button id="pay" type="submit">Send refund</button>
</form><pre id="result"></pre>`;

/** The final run's account page links (shop.ts), the reset link among them. */
const ACCOUNT_LINKS = `<p><a id="resign" href="/login-redirect?next=%2Faccount%3Fwelcome%3D1">Sign in again</a> · <a id="reset" href="/reset?token=nocpkResetTok55667788aabbccdd&email=admin%40cornershop.example">Reset password link</a> · <a href="/app">Open the orders app</a></p>`;

/** the-internet.herokuapp.com/forgot_password as it serves the form. */
const FORGOT = "https://the-internet.herokuapp.com/forgot_password";
const FORGOT_PASSWORD = `<form name="forgot_password" id="forgot_password" action="/forgot_password" method="post" >
     <div class="row">
      <div class="large-6 small-12 columns">
        <label for="email">E-mail</label>
        <input type="text" name="email" id="email" />
      </div>
    </div>
      <button id="form_submit" class="radius" type="submit"><i class="icon-2x icon-signin">Retrieve password</i></button>
  </form>`;

/** A pointer click as Chrome fires one on what lies under the pointer (the icon inside a button, say): pointerdown, then
 * click, with the page's own default action held back (a link here goes nowhere). */
function pointerAt(element: Element) {
  element.addEventListener("click", (event) => event.preventDefault(), {
    once: true,
  });
  element.dispatchEvent(
    trusted(new PointerEvent("pointerdown", { bubbles: true, composed: true })),
  );
  element.dispatchEvent(
    trusted(
      new MouseEvent("click", { bubbles: true, composed: true, button: 0 }),
    ),
  );
}

test("a button or link that names a password keeps its text, and the password, its field and the card stay masked", async () => {
  const pages = browse(() => {
    const checkout = openPage(
      "/checkout?order=1043",
      "Refund to card",
      CHECKOUT_WITH_TOGGLE,
    );
    // The page's own handler (shop.ts): Show password flips the field's type.
    field("#show-pw").addEventListener("click", () => {
      const password = field("#admin-password") as HTMLInputElement;
      password.type = password.type === "password" ? "text" : "password";
    });
    // Rows ...68029 to ...68035: the password typed, shown and hidden again, then the card.
    click("#admin-password");
    type("#admin-password", PASSWORD);
    pointerAt(field("#show-pw"));
    click("#admin-password");
    pointerAt(field("#show-pw"));
    click("#card-number");
    type("#card-number", CARD);
    checkout.leave();

    // Row ...68058: the reset link on the account page.
    const account = openPage("/account?welcome=1", "Account", ACCOUNT_LINKS);
    pointerAt(field("#reset"));
    account.leave();

    // Row ...95033: the-internet's Retrieve password, clicked on its icon.
    const forgot = openPage(FORGOT, "The Internet", FORGOT_PASSWORD);
    click("#email");
    type("#email", "tom@example.test");
    pointerAt(field("#form_submit > i"));
    forgot.leave();
    return {
      checkout: checkout.posted,
      account: account.posted,
      forgot: forgot.posted,
    };
  });

  await recordInWorker("/checkout?order=1043");
  postFromPage(pages.checkout, "/checkout?order=1043");
  await passwordKnown();
  fake?.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: `${SHOP}/account?welcome=1`,
    transitionType: "link",
  });
  postFromPage(pages.account, "/account?welcome=1");
  fake?.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: FORGOT,
    transitionType: "link",
  });
  postFromPage(pages.forgot, FORGOT);
  const clicked = (id: string) =>
    streamed()
      .filter((event) => event.name === "click")
      .map(
        (event) =>
          (
            event.value as {
              target: {
                text?: string;
                name?: string;
                label?: string;
                value?: string;
                attributes: Record<string, string>;
              };
            }
          ).target,
      )
      .filter((target) => target.attributes.id === id);
  await until(() => clicked("form_submit").length === 1, "Retrieve password");

  // CopilotKit's own copy of what the control says is kept as it sent it, beside its name and label.
  const words = (id: string) =>
    clicked(id).map(({ text, name, label }) => ({ text, name, label }));
  expect(words("show-pw")).toEqual([
    { text: "Show password", name: "Show password", label: "Show password" },
    { text: "Show password", name: "Show password", label: "Show password" },
  ]);
  expect(words("reset")).toEqual([
    {
      text: "Reset password link",
      name: "Reset password link",
      label: "Reset password link",
    },
  ]);
  expect(words("form_submit")).toEqual([
    {
      text: "Retrieve password",
      name: "Retrieve password",
      label: "Retrieve password",
    },
  ]);
  // What a control says is no secret, so nothing after it is masked for holding those words.
  for (const said of ["Show password", "Reset password link"])
    expect(networkDeps?.digests().has(sha256HexSync(said))).toBe(false);

  // The real secrets: the password, typed and then shown as text, its field's own copies, and the card.
  expect(leakedSecrets(streamed(), [PASSWORD, CARD])).toEqual([]);
  const passwordClicks = clicked("admin-password");
  expect(passwordClicks).toHaveLength(2);
  for (const target of passwordClicks) expect(target.value).toBe(REDACTED);
  expect(
    Object.fromEntries(edits().map((edit) => [edit.attributes.id, edit.value])),
  ).toMatchObject({ "admin-password": REDACTED, "card-number": REDACTED });
});

// ---- A save whose only typed values are secrets --------------------------------------------------------------------

/** The final run's verify recording on the checkout (fixtures/e2e-refund-secrets-only.json): its rows, and what the page
 * sent at the Send refund click, `at` milliseconds after it, as the shop logged it. */
const REFUND = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "e2e-refund-secrets-only.json"),
    "utf8",
  ),
) as {
  rows: (CapturedEvent & { row: string })[];
  requests: {
    at: number;
    type: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    postData: string;
    status: number;
    responseHeaders: Record<string, string>;
    body: string;
  }[];
};

type Step = {
  name: string;
  value: {
    target?: {
      name?: string;
      value?: string;
      attributes?: Record<string, string>;
    };
    request?: {
      method: string;
      url: string;
      status: number | null;
      body: { text?: string };
      response: { text?: string };
    };
  };
};

test("Send refund with only the password and the card typed carries the refund it posted, masked, as the run's row did not", async () => {
  const posted = browse(() => {
    const checkout = openPage(
      "/checkout?order=1043",
      "Refund to card",
      CHECKOUT_WITH_TOGGLE,
    );
    // The page's own handlers (shop.ts): Show password flips the field's type, and the card field puts the digits in
    // groups of four as they are typed, which is how the refund's body carries them.
    field("#show-pw").addEventListener("click", () => {
      const password = field("#admin-password") as HTMLInputElement;
      password.type = password.type === "password" ? "text" : "password";
    });
    const card = field("#card-number") as HTMLInputElement;
    card.addEventListener("input", () => {
      card.value = card.value
        .replace(/\D/g, "")
        .slice(0, 19)
        .replace(/(\d{4})(?=\d)/g, "$1 ");
    });
    // Rows ...34004 to ...34012, as run-verify.ts took them: the password typed, shown, a 9 added at its end, hidden
    // again, then the card, then Send refund. Nothing else was typed.
    click("#admin-password");
    type("#admin-password", PASSWORD);
    pointerAt(field("#show-pw"));
    click("#admin-password");
    type("#admin-password", "9");
    pointerAt(field("#show-pw"));
    click("#card-number");
    type("#card-number", CARD);
    submitWith("Send refund");
    checkout.leave();
    return checkout.posted;
  });
  const isSendRefund = (message: PortMessage) =>
    message.type === "content.event" &&
    message.event.name === "click" &&
    (message.event.value as Step["value"]).target?.attributes?.id === "pay";
  const at = posted.findIndex(isSendRefund);
  const sendRefund = posted[at];
  if (sendRefund?.type !== "content.event") throw new Error("No Send refund");

  await recordInWorker("/checkout?order=1043");
  // What the person typed reaches the worker as they type it, seconds before the click.
  postFromPage(posted.slice(0, at), "/checkout?order=1043");
  await until(
    () =>
      [`${PASSWORD}9`, CARD].every(
        (secret) => networkDeps?.digests().has(sha256HexSync(secret)) ?? false,
      ),
    "the password's and the card's digests in the worker",
  );
  // What the page sent at the click, by the shop's log: its telemetry, and the refund 4 ms after the click.
  for (const [index, request] of REFUND.requests.entries())
    debuggerPost({
      ...request,
      id: `refund-${index}`,
      at: sendRefund.event.timestamp + request.at,
    });
  await until(
    () => calls.some((call) => call.url.endsWith("/api/orders/1043/refunds")),
    "the refund",
  );
  postFromPage(posted.slice(at), "/checkout?order=1043");
  const steps = () =>
    streamed().filter((event) =>
      ["navigation", "click", "input"].includes(event.name),
    ) as unknown as Step[];
  await until(
    () =>
      steps().some(
        (step) =>
          step.name === "click" && step.value.target?.attributes?.id === "pay",
      ),
    "Send refund",
  );

  // The same steps as the run's rows ...34002 to ...34012.
  const shape = (step: Step) => ({
    name: step.name,
    target: step.value.target?.name,
    value: step.value.target?.value,
  });
  expect(steps().map(shape)).toEqual(
    (REFUND.rows as unknown as Step[]).map(shape),
  );
  // Row ...34012 carried no request: Send refund now carries the refund the page posted, with what was typed masked.
  const saves = steps().flatMap((step) =>
    step.value.request
      ? [{ on: step.value.target?.name, ...step.value.request }]
      : [],
  );
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({
    on: "Send refund",
    method: "POST",
    url: `${SHOP}/api/orders/1043/refunds`,
    status: 200,
    body: {
      text: `{"order":1043,"fullName":"","reason":"","password":"${REDACTED}","cardNumber":"${REDACTED}","notes":"","reference":"","amount":58.2}`,
    },
  });
  expect(
    leakedSecrets(streamed(), [
      PASSWORD,
      CARD,
      "4929 7311 2846 5036",
      "nocpkBearerTokAAAA1111BBBB2222CCCC3333",
      "nocpkApiKey-7f3e9a2b4c5d6e7f8a9b0c1d",
      "sess_nocpkSessTokQQQQRRRRSSSS112233",
      "nocpkSetCookieVal44556677",
    ]),
  ).toEqual([]);
});
