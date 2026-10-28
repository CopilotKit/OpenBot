import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type BrowserApiState,
  type BrowserWindow,
  browserApiPaths,
} from "@openbot/shared/openbot-browser";
import { recorderPaths } from "@openbot/shared/recorder-api";
import {
  RECORDER_EXTENSION_ID,
  RECORDER_STORE_IDS,
} from "@openbot/shared/recorder-extension";
import {
  environmentManager,
  focusManager,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import {
  BrowserNavItem,
  storeTabSentence,
} from "@/components/browser/browser-nav-item";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import {
  FakeRecorder,
  installChromeRuntime,
  setBrowserBrands,
} from "./recorder-page.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The sidebar's Browser button when OpenBot is open in the person's own Chrome or Edge, working with the Recorder in
 * that browser over the contract in shared/recorder-page.ts (`openbot.state`, `openbot.record`, `openbot.stop`), and
 * connecting it as Settings, Browsers does (`openbot.connect`). The Recorder is a stand-in that answers exactly as the
 * contract types it (recorder-page.fixture.ts); the server is a stand-in for its Browser and Recorder routes.
 *
 * Where the page cannot reach an extension at all (OpenBot Desktop's own app window, Safari, Firefox) the button is
 * what it was: browser-nav-item.test.tsx covers that behaviour, and the last tests here prove each of those places
 * still gets it.
 */

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  // The query library decided "server" when it was imported, before the DOM existed, and so never polls.
  environmentManager.setIsServer(() => false);
});
afterAll(async () => {
  await settleReactWork();
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const PERSON_BROWSER = `person-${"ef56".repeat(8)}`;
/** A store id, standing for the Recorder once it is published in the Chrome Web Store and Edge Add-ons. */
const CHROME_STORE_ID = "icpcnhgjghecmklnjbccdgdicklblcgd";
const EDGE_STORE_ID = "a".repeat(32);

/** Every server request the sidebar made, as `<method> <path>`. */
const requests: string[] = [];
let state: BrowserApiState;
let connectionsFail = false;
/** The signed-in person's narration choice as OpenBot keeps it on their account; undefined: no account to read. */
let accountNarration: "on" | "off" | null | undefined;
const preferenceWrites: unknown[] = [];

function closedState(shows: BrowserWindow): BrowserApiState {
  return {
    available: true,
    shows,
    computerId: PERSON_BROWSER,
    open: false,
    tabs: [],
  };
}

async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  requests.push(`${method} ${path}`);
  if (accountNarration !== undefined && path === "/api/me")
    return Response.json({
      user: {
        id: "ada",
        email: "ada@example.com",
        role: "user",
        onboarding: null,
      },
    });
  if (accountNarration !== undefined && path === "/api/settings/preferences") {
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as {
        narration: "on" | "off";
      };
      preferenceWrites.push(body);
      accountNarration = body.narration;
    }
    return Response.json({
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: false,
        narration: accountNarration,
      },
    });
  }
  if (path === browserApiPaths.state && method === "GET")
    return Response.json(state);
  if (path === browserApiPaths.open && method === "POST")
    return Response.json({
      ok: true,
      computerId: PERSON_BROWSER,
      browser: "chrome",
      window: "native",
      narration: "own",
    });
  if (path === recorderPaths.connections && method === "GET") {
    if (connectionsFail)
      return Response.json({ error: "Unavailable" }, { status: 500 });
    return Response.json({
      connections: [],
      extensionIds: [RECORDER_EXTENSION_ID],
    });
  }
  if (path === recorderPaths.connectCodes && method === "POST")
    return Response.json(
      {
        code: `obc_${"x".repeat(20)}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { status: 201 },
    );
  return new Response(null, { status: 404 });
}

const originalFetch = global.fetch;
/** What each test changed about the browser, taken back after it. */
let undo: (() => void)[] = [];
beforeEach(() => {
  queryClient.clear();
  requests.length = 0;
  connectionsFail = false;
  accountNarration = undefined;
  preferenceWrites.length = 0;
  state = closedState("screen");
  global.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      server(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  for (const step of undo.reverse()) step();
  undo = [];
  RECORDER_STORE_IDS.chrome = undefined;
  RECORDER_STORE_IDS.edge = undefined;
  delete RECORDER_STORE_IDS.chrome;
  delete RECORDER_STORE_IDS.edge;
});

/** OpenBot open in Google Chrome (or Edge) holding `recorders`; none: no extension gave the page `sendMessage`. */
function inBrowser(
  brands: "chrome" | "edge",
  recorders: FakeRecorder[] | null,
) {
  undo.push(setBrowserBrands(brands));
  if (recorders) undo.push(installChromeRuntime(recorders));
}

/** The Recorder published in both stores, as `shared/recorder-extension.json` will say once it is. */
function published() {
  RECORDER_STORE_IDS.chrome = CHROME_STORE_ID;
  RECORDER_STORE_IDS.edge = EDGE_STORE_ID;
}

/** The sidebar as the app draws it, with the app's one query client and its toasts, on a router starting at home. */
function draw() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SidebarProvider>
          <SidebarMenu>
            <BrowserNavItem />
          </SidebarMenu>
        </SidebarProvider>
        <Outlet />
        <Toaster />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <p>Home</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/browser",
      component: () => <p>The Browser page</p>,
    }),
  ]);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree,
  });
  const view = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { view, router };
}

const dots = (view: ReturnType<typeof draw>["view"]) =>
  view.queryAllByRole("img").map((dot) => dot.getAttribute("aria-label"));
const toasts = () =>
  [...document.querySelectorAll("[data-slot=toast]")].map(
    (toast) => toast.textContent,
  );
/** The server's Browser routes the sidebar used: none of them, when the Recorder in this browser does the work. */
const browserRoutes = () =>
  requests.filter(
    (request) =>
      request.includes(browserApiPaths.open) ||
      request.includes(browserApiPaths.recording),
  );
/** What the Recorder was sent, by message type. */
const sent = (recorder: FakeRecorder, type: string) =>
  recorder.received.filter(
    (message) => (message as { type?: string }).type === type,
  );
/** The popover on screen, by its text. */
const popover = () =>
  document.querySelector("[data-slot=popover-content]")?.textContent ?? null;

test("with the Recorder here and connected, one click opens a popover where Record and Stop go to the Recorder, the dot follows it at once, and Stop says what was saved", async () => {
  const recorder = new FakeRecorder();
  recorder.connected = true;
  inBrowser("chrome", [recorder]);
  const { view, router } = draw();
  // Hosted OpenBot, which used to send this button to the browser in the page: here it is the browser it is open in.
  const button = await view.findByRole("button", { name: "Browser" });
  expect(view.queryByRole("link", { name: "Browser" })).toBeNull();
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  expect(button.getAttribute("aria-expanded")).toBe("false");

  const user = userEvent.setup({ document });
  await user.click(button);
  const dialog = await view.findByRole("dialog", { name: "Record a task" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  // It says what a recording holds before Record is pressed, the saves and AI assistant conversations among it.
  expect(dialog.textContent).toContain(
    "What you do in this browser goes into your own Learning space, in every tab you use, until you stop: your steps, what each step saves, AI assistant conversations, and your narration when it's on.",
  );
  // Focus goes to the task name, ready to type.
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Task name",
    ),
  );
  const record = view.getByRole("button", { name: "Record" });
  expect(record.hasAttribute("disabled")).toBe(true);

  await user.type(
    view.getByRole("textbox", { name: "Task name" }),
    "  Submit the receipt ",
  );
  await user.click(record);
  await waitFor(() =>
    expect(sent(recorder, "openbot.record")).toEqual([
      { type: "openbot.record", title: "Submit the receipt" },
    ]),
  );
  // The popover and the dot read the Recorder's own report, with no wait for the server.
  expect(
    await view.findByRole("dialog", { name: "Submit the receipt" }),
  ).toBeTruthy();
  expect(dots(view)).toEqual([
    expect.stringMatching(/^Recording: Submit the receipt, 0:0\d$/),
  ]);
  expect(view.getByRole("timer").textContent).toMatch(/^0:0\d · 0 actions$/);
  expect(dialog.isConnected).toBe(true);

  // The person works in another tab; the Recorder counts what they do, and the popover follows it every second.
  recorder.actions = 3;
  await waitFor(
    () =>
      expect(view.getByRole("timer").textContent).toMatch(
        /^0:0\d · 3 actions$/,
      ),
    { timeout: 2500 },
  );

  await user.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(sent(recorder, "openbot.stop").length).toBe(1));
  await view.findByRole("dialog", { name: "Record a task" });
  expect(view.getByRole("status").textContent).toBe(
    "Saved “Submit the receipt” to your Learning space: 3 actions.",
  );
  await waitFor(() => expect(dots(view)).toEqual([]));

  // None of it went through the server's Browser routes, and the person never left where they were.
  expect(browserRoutes()).toEqual([]);
  expect(router.state.location.pathname).toBe("/");
}, 15_000);

test("Record here carries the person's narration choice from their account, and asks before their first recording as the Browser page does", async () => {
  // OpenBot keeps the choice on the person's account and its own Record form passes it on; Record from the everyday
  // browser left it out, so the Recorder went by its own setting.
  const recorder = new FakeRecorder();
  recorder.connected = true;
  inBrowser("chrome", [recorder]);
  accountNarration = "off";
  const { view } = draw();
  const user = userEvent.setup({ document });
  const recordTask = async (name: string) => {
    await user.click(await view.findByRole("button", { name: "Browser" }));
    await user.type(
      await view.findByRole("textbox", { name: "Task name" }),
      name,
    );
    await user.click(view.getByRole("button", { name: "Record" }));
  };
  await recordTask("Submit the receipt");
  await waitFor(() =>
    expect(sent(recorder, "openbot.record")).toEqual([
      { type: "openbot.record", title: "Submit the receipt", narrate: false },
    ]),
  );
  await user.click(await view.findByRole("button", { name: "Stop" }));
  await waitFor(() => expect(sent(recorder, "openbot.stop").length).toBe(1));
  await user.keyboard("{Escape}");

  // A person who never chose is asked first, and the answer goes with the Record and is kept.
  accountNarration = null;
  await act(() => queryClient.invalidateQueries());
  await recordTask("Book the room");
  const question = await view.findByRole("dialog", {
    name: "Narrate while you record?",
  });
  expect(sent(recorder, "openbot.record")).toHaveLength(1);
  await user.click(
    within(question).getByRole("button", { name: "Record with narration" }),
  );
  await waitFor(() =>
    expect(sent(recorder, "openbot.record")).toEqual([
      { type: "openbot.record", title: "Submit the receipt", narrate: false },
      { type: "openbot.record", title: "Book the room", narrate: true },
    ]),
  );
  expect(preferenceWrites).toEqual([{ narration: "on" }]);
}, 15_000);

test("Record and Stop from the keyboard: Tab to the button, Enter opens the popover, Escape closes it and gives the button its focus back", async () => {
  const recorder = new FakeRecorder();
  recorder.connected = true;
  inBrowser("edge", [recorder]);
  const { view } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  const user = userEvent.setup({ document });
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  await view.findByRole("dialog", { name: "Record a task" });
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Task name",
    ),
  );
  await user.keyboard("Book the flight{Enter}");
  await view.findByRole("dialog", { name: "Book the flight" });
  // Record gave way to Stop, the one control while it records, and the keyboard is on it rather than lost.
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Stop"));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(popover()).toBeNull());
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  // Still recording, which the dot says.
  expect(dots(view)).toEqual([
    expect.stringMatching(/^Recording: Book the flight, 0:0\d$/),
  ]);
  await user.keyboard(" ");
  await view.findByRole("dialog", { name: "Book the flight" });
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Stop"));
  await user.keyboard("{Enter}");
  await view.findByRole("dialog", { name: "Record a task" });
  // And Stop gave way to the task name, ready for the next one.
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Task name",
    ),
  );
  expect(view.getByRole("status").textContent).toBe(
    "Nothing was recorded in “Book the flight”. The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out.",
  );
});

test("a Record the Recorder refuses shows its own sentence in the popover, and a Record that works takes it away", async () => {
  const recorder = new FakeRecorder();
  recorder.connected = true;
  recorder.refuseRecord = "Open a website in this browser to record it.";
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Browser" }));
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Pay the invoice{Enter}",
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Open a website in this browser to record it.",
  );
  // Not a toast: the popover is where the person pressed Record.
  expect(toasts()).toEqual([]);
  recorder.refuseRecord = null;
  await user.click(view.getByRole("button", { name: "Record" }));
  await view.findByRole("dialog", { name: "Pay the invoice" });
  expect(view.queryByRole("alert")).toBeNull();
});

test("the dot is read from the Recorder every second while it records and rarely while it does not", async () => {
  const recorder = new FakeRecorder();
  recorder.connected = true;
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  await view.findByRole("button", { name: "Browser" });
  const asked = () => sent(recorder, "openbot.state").length;
  await waitFor(() => expect(asked()).toBe(1));
  await act(() => Bun.sleep(2200));
  expect(asked()).toBe(1);

  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Browser" }));
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "File the report{Enter}",
  );
  await view.findByRole("dialog", { name: "File the report" });
  const recording = asked();
  await act(() => Bun.sleep(2200));
  expect(asked()).toBeGreaterThanOrEqual(recording + 2);
}, 15_000);

test("after Stop the dot does not wait for the server to hear of it: a recording this Recorder stopped lights nothing", async () => {
  const recorder = new FakeRecorder();
  recorder.connected = true;
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Browser" }));
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Close the ticket{Enter}",
  );
  await view.findByRole("dialog", { name: "Close the ticket" });
  await user.click(view.getByRole("button", { name: "Stop" }));
  await view.findByRole("dialog", { name: "Record a task" });
  // The server still has the Recorder's last report of that recording (it reports every 30 s and on each change).
  state = {
    ...closedState("screen"),
    activity: {
      phase: "recording",
      recordingId: "rec-1",
      title: "Close the ticket",
      startedAt: Date.now() - 5000,
      actions: 0,
    },
  };
  await queryClient.invalidateQueries();
  await act(() => Bun.sleep(100));
  expect(dots(view)).toEqual([]);

  // A recording in another of the person's browsers still lights it.
  state = {
    ...closedState("screen"),
    activity: {
      phase: "recording",
      recordingId: "rec-elsewhere",
      title: "Submit the timesheet",
      startedAt: Date.now() - 5000,
      actions: 2,
    },
  };
  await queryClient.invalidateQueries();
  expect(
    await view.findByRole("img", {
      name: /^Recording: Submit the timesheet, 0:0\d$/,
    }),
  ).toBeTruthy();
});

test("with the Recorder here but not connected, one click connects it as Settings does, the popover waits for the Connect click in the Recorder's tab, then shows Record", async () => {
  const recorder = new FakeRecorder();
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Browser" }));
  // A code minted by the server, handed to the Recorder with openbot.connect.
  await waitFor(() =>
    expect(sent(recorder, "openbot.connect")).toEqual([
      { type: "openbot.connect", code: `obc_${"x".repeat(20)}` },
    ]),
  );
  expect(requests).toContain(`POST ${recorderPaths.connectCodes}`);
  await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
  expect(
    view.getByRole("dialog", { name: "Connect the OpenBot Recorder" }),
  ).toBeTruthy();

  // The person clicks Connect on the Recorder's page; OpenBot hears of it within the 2 s it asks in while it waits.
  recorder.confirm();
  await view.findByRole("dialog", { name: "Record a task" }, { timeout: 3000 });
  // One connect, however long it waited.
  expect(sent(recorder, "openbot.connect").length).toBe(1);
  await user.type(
    view.getByRole("textbox", { name: "Task name" }),
    "Approve the leave{Enter}",
  );
  await view.findByRole("dialog", { name: "Approve the leave" });
}, 10_000);

test("a Cancel on the Recorder's Connect page reaches the popover within a second, which says so and offers Connect again", async () => {
  // After a Cancel, OpenBot used to go on saying "Confirm in the OpenBot Recorder tab that opened." for up to five
  // minutes: nothing told it the person had cancelled.
  const recorder = new FakeRecorder();
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Browser" }));
  await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
  recorder.cancel();
  await view.findByText(
    "You cancelled in the OpenBot Recorder tab. Nothing was connected.",
    {},
    { timeout: 1500 },
  );
  // Connect again asks the Recorder again, and waits on its Connect page afresh.
  await user.click(view.getByRole("button", { name: "Connect this browser" }));
  await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
  expect(sent(recorder, "openbot.connect").length).toBe(2);
  recorder.closeTab();
  await view.findByText(
    "The OpenBot Recorder tab closed before you confirmed. Nothing was connected.",
    {},
    { timeout: 1500 },
  );
}, 10_000);

test("for a trusted OpenBot the one click connects the Recorder with no Connect page, and the popover opens on Record", async () => {
  const recorder = new FakeRecorder();
  recorder.trusted = true;
  inBrowser("edge", [recorder]);
  const { view } = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Browser" }));
  await view.findByRole("dialog", { name: "Record a task" });
  expect(sent(recorder, "openbot.connect").length).toBe(1);
  expect(recorder.connected).toBe(true);
  // The popover opened on the connect message, with nothing in it to focus, so focus sat on the popover; it moves to
  // the task name once that appears, so the person can type at once (the real-browser run found it left behind).
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Task name",
    ),
  );
  expect(
    view.queryByText("Confirm in the OpenBot Recorder tab that opened."),
  ).toBeNull();
});

test("a connect the Recorder refuses says why in its own sentence, and Try again asks again", async () => {
  const recorder = new FakeRecorder();
  recorder.refuseConnect = "pinned-elsewhere";
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Browser" }));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Your organization set the Recorder to another OpenBot.",
  );
  // Reopening the popover does not ask again by itself.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(popover()).toBeNull());
  await user.click(view.getByRole("button", { name: "Browser" }));
  await view.findByRole("alert");
  expect(sent(recorder, "openbot.connect").length).toBe(1);

  recorder.refuseConnect = null;
  recorder.trusted = true;
  await user.click(view.getByRole("button", { name: "Try again" }));
  await view.findByRole("dialog", { name: "Record a task" });
  expect(sent(recorder, "openbot.connect").length).toBe(2);
});

for (const [error, sentence] of [
  [
    "exchange-refused",
    "OpenBot didn't accept the Recorder's connect request. Try again.",
  ],
  [
    "openbot-unreachable",
    "The Recorder couldn't reach OpenBot to connect. Check your connection and try again.",
  ],
] as const) {
  test(`a trusted connect the Recorder could not complete with OpenBot (${error}) says so in OpenBot's words`, async () => {
    const recorder = new FakeRecorder();
    recorder.trusted = true;
    recorder.refuseConnect = error;
    inBrowser("chrome", [recorder]);
    const { view } = draw();
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: "Browser" }));
    expect((await view.findByRole("alert")).textContent).toBe(sentence);
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
}

for (const [brands, store, url, name] of [
  [
    "chrome",
    "chrome",
    `https://chromewebstore.google.com/detail/${CHROME_STORE_ID}`,
    "Google Chrome",
  ],
  [
    "edge",
    "edge",
    `https://microsoftedge.microsoft.com/addons/detail/${EDGE_STORE_ID}`,
    "Microsoft Edge",
  ],
] as const) {
  test(`in ${name} with no Recorder, one click opens its store page there in a new tab with a short note, and once it is added the button connects it`, async () => {
    published();
    // No extension lists OpenBot in its externally_connectable, so the page has no `chrome.runtime` at all.
    inBrowser(brands, null);
    const { view, router } = draw();
    const link = await view.findByRole("link", { name: "Browser" });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // A new tab is the browser's to open; the test sees the click and the note.
    link.addEventListener("click", (event) => event.preventDefault());
    const user = userEvent.setup({ document });
    await user.click(link);
    await waitFor(() => expect(toasts()).toEqual([storeTabSentence(store)]));
    expect(storeTabSentence(store)).toBe(
      `The OpenBot Recorder's page is open in a new tab. Add it to ${name} to record from OpenBot.`,
    );
    expect(router.state.location.pathname).toBe("/");
    expect(browserRoutes()).toEqual([]);

    // The person adds it, which gives this page `chrome.runtime` at once, and comes back to OpenBot's tab.
    const recorder = new FakeRecorder();
    undo.push(installChromeRuntime([recorder]));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    undo.push(() => focusManager.setFocused(undefined));
    const button = await view.findByRole("button", { name: "Browser" });
    recorder.trusted = true;
    await user.click(button);
    await view.findByRole("dialog", { name: "Record a task" });
  });
}

test("where another extension gave the page chrome.runtime but the Recorder is not in it, the click still opens its store page", async () => {
  published();
  inBrowser("chrome", []);
  const { view } = draw();
  const link = await view.findByRole("link", { name: "Browser" });
  expect(link.getAttribute("href")).toBe(
    `https://chromewebstore.google.com/detail/${CHROME_STORE_ID}`,
  );
});

test("before the Recorder is published, Chrome with no Recorder keeps today's button: hosted, the link to the Browser page", async () => {
  inBrowser("chrome", null);
  const { view } = draw();
  const link = await view.findByRole("link", { name: "Browser" });
  expect(link.getAttribute("href")).toBe("/browser");
});

test("before the Recorder is published, Chrome with no Recorder keeps today's button: on OpenBot Desktop, the one that opens the person's browser", async () => {
  state = closedState("native");
  inBrowser("chrome", []);
  const { view } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  expect(button.getAttribute("aria-haspopup")).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() =>
    expect(requests).toContain(`POST ${browserApiPaths.open}`),
  );
});

test("a Recorder from before openbot.state keeps today's button, as OpenBot cannot drive it from here", async () => {
  const recorder = new FakeRecorder();
  recorder.connected = true;
  recorder.older = true;
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const link = await view.findByRole("link", { name: "Browser" });
  expect(link.getAttribute("href")).toBe("/browser");
  expect(sent(recorder, "openbot.state").length).toBe(1);
});

test("OpenBot Desktop's own app window on Windows (WebView2, which reports Edge's brand) keeps today's button and asks no extension anything", async () => {
  state = closedState("native");
  const recorder = new FakeRecorder();
  recorder.connected = true;
  undo.push(setBrowserBrands("edge"));
  // WebView2 gives its page `chrome.webview` for its host; were it to give `chrome.runtime` as well, still nothing.
  undo.push(installChromeRuntime([recorder], { webview: {} }));
  const { view } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  expect(button.getAttribute("aria-haspopup")).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() =>
    expect(requests).toContain(`POST ${browserApiPaths.open}`),
  );
  expect(recorder.received).toEqual([]);
  expect(requests).not.toContain(`GET ${recorderPaths.connections}`);
});

for (const [where, setUp] of [
  [
    "Safari and Firefox (no chrome, no userAgentData)",
    () => setBrowserBrands(null),
  ],
  [
    "OpenBot Desktop's own app window on macOS (a WebKit view)",
    () => setBrowserBrands(null),
  ],
  ["Chrome on a phone", () => setBrowserBrands("chrome", { mobile: true })],
  [
    "another Chromium browser with no extension reachable",
    () => setBrowserBrands("chromium"),
  ],
] as const) {
  test(`${where} keeps today's button and asks the server nothing more`, async () => {
    published();
    undo.push(setUp());
    const { view } = draw();
    const link = await view.findByRole("link", { name: "Browser" });
    expect(link.getAttribute("href")).toBe("/browser");
    expect(requests).toEqual([`GET ${browserApiPaths.state}`]);
  });
}

test("where the server cannot say which Recorders it trusts, the button is today's", async () => {
  connectionsFail = true;
  const recorder = new FakeRecorder();
  recorder.connected = true;
  inBrowser("chrome", [recorder]);
  const { view } = draw();
  const link = await view.findByRole(
    "link",
    { name: "Browser" },
    { timeout: 5000 },
  );
  expect(link.getAttribute("href")).toBe("/browser");
}, 10_000);
