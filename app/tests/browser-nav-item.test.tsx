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
  type BrowserOpenResponse,
  type BrowserWindow,
  browserApiPaths,
  type LauncherState,
  type RealBrowserOpenResponse,
} from "@openbot/shared/openbot-browser";
import type { RecorderActivity } from "@openbot/shared/recorder-api";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import {
  BrowserNavItem,
  storeOpenedSentence,
} from "@/components/browser/browser-nav-item";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { browserKeys } from "@/lib/browser/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The sidebar's Browser button, against the server's Browser routes as the contract in shared/openbot-browser.ts types
 * them: one click opens the person's browser. On OpenBot Desktop (`shows: "native"`) that is their own Chrome window,
 * opened or brought to the front while they stay where they are; on hosted OpenBot (`shows: "screen"`) it is the
 * Browser page. On Desktop the click may instead bring the person's own everyday Chrome or Edge forward, or open the
 * Recorder's store page there, which a short note says. While any of the person's Recorders records (the server's
 * `activity`), in either, the button carries a red dot named for it.
 */

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  // The query library decided "server" when it was imported, before the DOM existed, and so never polls. The sidebar's
  // polling is what this file is about.
  environmentManager.setIsServer(() => false);
});
afterAll(async () => {
  await settleReactWork();
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const PERSON_BROWSER = `person-${"cd34".repeat(8)}`;
/** What the server says when the person's browser cannot open for OpenBot's own setup (server/src/browser/routes.ts). */
const NOT_SET_UP =
  "Your browser can't open right now. Ask an admin to check OpenBot's setup.";

/** Every request the button made, as `<method> <path>`. */
const requests: string[] = [];
let state: BrowserApiState;
let stateFails = false;
/** How the server answers the next open: a refusal with its sentence, an answer held until `release` is called, or what
 * it did with the person's own browser on OpenBot Desktop. */
let nextOpen:
  | { refuse: string }
  | { held: Promise<void> }
  | { real: RealBrowserOpenResponse }
  | { shownAs: BrowserWindow }
  | null = null;

const recorderIdle = (window: BrowserWindow): LauncherState => ({
  connected: true,
  phase: "idle",
  actions: 0,
  ...(window === "native"
    ? { narration: "own", voice: "off" }
    : { narration: "external" }),
});

/** The state before the person's browser has ever been opened, as the server answers it: where it would show. */
function closedState(shows: BrowserWindow): BrowserApiState {
  return {
    available: true,
    shows,
    computerId: PERSON_BROWSER,
    open: false,
    tabs: [],
  };
}

function openState(shows: BrowserWindow): BrowserApiState {
  return {
    ...closedState(shows),
    open: true,
    browser: shows === "native" ? "chrome" : "chromium",
    window: shows,
    narration: shows === "native" ? "own" : "external",
    recorder: recorderIdle(shows),
    tabs:
      shows === "native"
        ? []
        : [
            {
              id: "tab-1",
              url: "https://example.com/",
              title: "Example Domain",
              active: true,
            },
          ],
  };
}

/** A Recorder at `phase`, recording "Submit the receipt" for the last 83 seconds, as the server's `activity` has it. */
function receipt(phase: LauncherState["phase"]): RecorderActivity {
  return {
    phase,
    recordingId: "rec-1",
    title: "Submit the receipt",
    startedAt: Date.now() - 83_000,
    actions: 4,
  };
}

/** The Recorder in the open OpenBot browser at `phase`: its own report, and the `activity` the server makes of it. */
function recording(
  phase: LauncherState["phase"],
  shows: BrowserWindow = "native",
): BrowserApiState {
  const open = openState(shows);
  return {
    ...open,
    recorder: {
      ...(open.recorder as LauncherState),
      ...receipt(phase),
      ...(shows === "native" ? { voice: "listening" as const } : {}),
    },
    activity: receipt(phase),
  };
}

/** The server's two Browser routes the button uses, as the contract has them. */
async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  requests.push(`${method} ${path}`);
  if (path === browserApiPaths.state && method === "GET") {
    if (stateFails)
      return Response.json({ error: "Unavailable" }, { status: 500 });
    return Response.json(state);
  }
  if (path === browserApiPaths.open && method === "POST") {
    // The route takes no body.
    if (init?.body !== undefined)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    const answer = nextOpen;
    nextOpen = null;
    if (answer && "refuse" in answer)
      return Response.json({ error: answer.refuse }, { status: 503 });
    if (answer && "real" in answer) return Response.json(answer.real);
    if (answer && "held" in answer) await answer.held;
    // Where the browser that opened shows, which is not always where the state said it would: OpenBot Desktop opens a
    // browser in the page where it finds no Chrome or Edge.
    const shows =
      answer && "shownAs" in answer
        ? answer.shownAs
        : (state.shows ?? "screen");
    // Brought to the front when it is open already, as it is.
    if (!state.open) state = openState(shows);
    return Response.json({
      ok: true,
      computerId: PERSON_BROWSER,
      browser: shows === "native" ? "chrome" : "chromium",
      window: shows,
      narration: shows === "native" ? "own" : "external",
    } satisfies BrowserOpenResponse);
  }
  return new Response(null, { status: 404 });
}

const originalFetch = global.fetch;
beforeEach(() => {
  queryClient.clear();
  requests.length = 0;
  stateFails = false;
  nextOpen = null;
  state = closedState("native");
  global.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      server(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

/**
 * The sidebar as the app draws it, in strict mode with the app's one query client and its toasts, on a router with the
 * Browser page's address, starting at home. Every address the router went to is kept, to show the Browser page was
 * never reached.
 */
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
  const visited: string[] = [];
  router.subscribe("onResolved", (event) => {
    visited.push(event.toLocation.pathname);
  });
  const view = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { view, router, visited };
}

/** The names of the red dots on screen. Names rather than elements: a failed check prints what it found, and an
 * element prints the whole document's globals with it. */
const dots = (view: ReturnType<typeof draw>["view"]) =>
  view.queryAllByRole("img").map((dot) => dot.getAttribute("aria-label"));

const opens = () =>
  requests.filter((request) => request === `POST ${browserApiPaths.open}`)
    .length;
/** What each toast on screen says. */
const toasts = () =>
  [...document.querySelectorAll("[data-slot=toast]")].map(
    (toast) => toast.textContent,
  );
const reads = () =>
  requests.filter((request) => request === `GET ${browserApiPaths.state}`)
    .length;

test("on OpenBot Desktop the Browser button opens the person's own window in one click and leaves them where they are", async () => {
  const { view, router, visited } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  // A button, not a link: it goes nowhere.
  expect(button.tagName).toBe("BUTTON");
  expect(view.queryByRole("link", { name: "Browser" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() => expect(opens()).toBe(1));
  await waitFor(() => expect(state.open).toBe(true));
  // Brought to the front again, with the same click: nothing about it differs once the window is open.
  await waitFor(() =>
    expect(button.getAttribute("aria-busy")).not.toBe("true"),
  );
  await user.click(button);
  await waitFor(() => expect(opens()).toBe(2));
  expect(router.state.location.pathname).toBe("/");
  expect(visited).not.toContain("/browser");
  expect(view.getByText("Home")).toBeTruthy();
});

test("on OpenBot Desktop, a click that opened a browser in the page takes the person to it", async () => {
  // The end-to-end run: "Opening…" for seconds, then the person left on Home while their browser opened on the Browser
  // page they could not see.
  const { view, router } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  nextOpen = { shownAs: "screen" };
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() => expect(router.state.location.pathname).toBe("/browser"));
  expect(await view.findByText("The Browser page")).toBeTruthy();
  expect(opens()).toBe(1);
  expect(toasts()).toEqual([]);
});

test("on OpenBot Desktop the keyboard opens the window as a button does: Tab to it, then Enter or Space", async () => {
  const { view, visited } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  const user = userEvent.setup({ document });
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(opens()).toBe(1));
  await waitFor(() =>
    expect(button.getAttribute("aria-busy")).not.toBe("true"),
  );
  await user.keyboard(" ");
  await waitFor(() => expect(opens()).toBe(2));
  expect(visited).not.toContain("/browser");
});

/** Whether the sidebar draws this row as disabled: its menu buttons are half opacity, and take no pointer, exactly when
 * they are `:disabled` or `aria-disabled="true"` (components/ui/sidebar.tsx). */
const drawnDisabled = (element: Element) =>
  element.matches(":disabled, [aria-disabled='true']");

test("while the window is opening the button says so, at full contrast, and takes no further click, then is itself again", async () => {
  let release = () => {};
  nextOpen = {
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const { view } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(button.textContent).toBe("BrowserOpening…");
  // Busy, not disabled: run 7 found "Opening…" too faint to read at the half opacity the sidebar gives a disabled row.
  expect(drawnDisabled(button)).toBe(false);
  // Clicked again, and pressed from the keyboard, while it opens: still the one open.
  await user.click(button);
  button.focus();
  await user.keyboard("{Enter}");
  expect(opens()).toBe(1);
  // It keeps the keyboard's focus while it is busy.
  expect(document.activeElement).toBe(button);

  release();
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  expect(drawnDisabled(button)).toBe(false);
  expect(button.textContent).toBe("Browser");
  expect(opens()).toBe(1);
});

test("a refused open shows the server's own sentence in a toast that stays until the person closes it, and the button can be pressed again", async () => {
  nextOpen = { refuse: NOT_SET_UP };
  const { view, router } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() => expect(toasts()).toEqual([NOT_SET_UP]));
  // Read out as it appears, not only when somebody goes looking for it: Base UI says an urgent toast in an alert of its
  // own, and hides the drawn one from a screen reader so it is not said twice.
  expect(
    view.getAllByRole("alert").map((alert) => alert.textContent),
  ).toContain(NOT_SET_UP);
  expect(router.state.location.pathname).toBe("/");
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());

  // Still there well after the 5 seconds a toast lasts on its own: run 7 found it gone by itself, and somebody who
  // looked away never learned why their browser did not open.
  await act(() => Bun.sleep(6000));
  expect(toasts()).toEqual([NOT_SET_UP]);

  // Refused twice: one toast saying it, not two.
  nextOpen = { refuse: NOT_SET_UP };
  await user.click(button);
  await waitFor(() => expect(opens()).toBe(2));
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  expect(toasts()).toEqual([NOT_SET_UP]);

  // A third try that opens says nothing more, and takes the refusal away, which is no longer true.
  await user.click(button);
  await waitFor(() => expect(state.open).toBe(true));
  expect(opens()).toBe(3);
  await waitFor(() => expect(toasts()).toEqual([]));

  // And a refusal the person has read goes when they close it.
  nextOpen = { refuse: NOT_SET_UP };
  await user.click(button);
  await waitFor(() => expect(toasts()).toEqual([NOT_SET_UP]));
  const close = document.querySelector("[data-slot=toast-close]");
  expect(close?.getAttribute("aria-label")).toBe("Close");
  await user.click(close as HTMLElement);
  await waitFor(() => expect(toasts()).toEqual([]));
  expect(opens()).toBe(4);
}, 15_000);

test("on hosted OpenBot the Browser button is a link to the browser in the page, and the click opens nothing itself", async () => {
  state = closedState("screen");
  const { view, router } = draw();
  const link = await view.findByRole("link", { name: "Browser" });
  expect(link.getAttribute("href")).toBe("/browser");
  expect(view.queryByRole("button", { name: "Browser" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.click(link);
  await waitFor(() => expect(router.state.location.pathname).toBe("/browser"));
  expect(view.getByText("The Browser page")).toBeTruthy();
  // The Browser page opens the browser when it arrives; the sidebar does not open it as well.
  expect(opens()).toBe(0);

  // And from the keyboard, as a link: Enter follows it.
  await router.navigate({ to: "/" });
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  link.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe("/browser"));
  expect(opens()).toBe(0);
});

test("a server from before shows was said keeps the Browser button a link to the Browser page", async () => {
  const { shows: _unsaid, ...older } = closedState("native");
  state = older;
  const { view } = draw();
  const link = await view.findByRole("link", { name: "Browser" });
  expect(link.getAttribute("href")).toBe("/browser");
});

test("the sidebar has no Browser button where OpenBot cannot run one, or cannot say", async () => {
  state = {
    available: false,
    computerId: PERSON_BROWSER,
    open: false,
    tabs: [],
  };
  const { view } = draw();
  await waitFor(() =>
    expect(queryClient.getQueryState(browserKeys.state)?.status).toBe(
      "success",
    ),
  );
  expect(view.queryByRole("button", { name: "Browser" })).toBeNull();
  expect(view.queryByRole("link", { name: "Browser" })).toBeNull();
  cleanup();

  queryClient.clear();
  stateFails = true;
  const failed = draw();
  await waitFor(
    () =>
      expect(queryClient.getQueryState(browserKeys.state)?.status).toBe(
        "error",
      ),
    { timeout: 4000 },
  );
  expect(failed.view.queryByRole("button", { name: "Browser" })).toBeNull();
  expect(failed.view.queryByRole("link", { name: "Browser" })).toBeNull();
});

for (const shows of ["native", "screen"] as const) {
  test(`a Record pressed in the browser itself puts a red dot named for the recording on the ${shows === "native" ? "Desktop" : "hosted"} Browser button within two seconds, and Stop takes it away`, async () => {
    state = openState(shows);
    const { view } = draw();
    await view.findByRole(shows === "native" ? "button" : "link", {
      name: "Browser",
    });
    expect(dots(view)).toEqual([]);

    // Record, pressed in the Recorder's own toolbar button: the only place OpenBot hears of it is the state it reads.
    const asked = reads();
    state = recording("recording", shows);
    const dot = await view.findByRole(
      "img",
      { name: /^Recording: Submit the receipt, 1:2\d$/ },
      { timeout: 2000 },
    );
    expect(reads()).toBeGreaterThan(asked);
    // The button carries the recording's name with its own, for a screen reader.
    expect(
      view.getByRole(shows === "native" ? "button" : "link", {
        name: /^Browser Recording: Submit the receipt, 1:2\d$/,
      }),
    ).toBeTruthy();
    expect(dot.querySelector(".bg-destructive")).not.toBeNull();

    // Stopping, then stopped.
    state = recording("stopping", shows);
    expect(
      await view.findByRole(
        "img",
        { name: "Recording: Submit the receipt, stopping" },
        { timeout: 2000 },
      ),
    ).toBeTruthy();
    state = openState(shows);
    await waitFor(() => expect(dots(view)).toEqual([]), {
      timeout: 2000,
    });
  });
}

test("the red dot shows while a recording starts as well, and its tooltip names the recording", async () => {
  state = recording("starting");
  const { view } = draw();
  expect(
    await view.findByRole("img", {
      name: "Recording: Submit the receipt, starting",
    }),
  ).toBeTruthy();
  state = recording("recording");
  await view.findByRole(
    "img",
    { name: /^Recording: Submit the receipt, 1:2\d$/ },
    { timeout: 2000 },
  );
  const user = userEvent.setup({ document });
  await user.hover(view.getByRole("button", { name: /^Browser Recording/ }));
  // Base UI's tooltip is drawn for sight alone, so it says what the dot's name says.
  await waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-slot=tooltip-content]")].map(
        (tooltip) => tooltip.textContent,
      ),
    ).toEqual([
      expect.stringMatching(/^Recording: Submit the receipt, 1:2\d$/),
    ]),
  );
});

test("the sidebar asks often while the browser is open and rarely while it is closed, and opening it never waits for the next ask", async () => {
  const { view } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  await waitFor(() => expect(reads()).toBe(1));
  // Closed: nothing more for well over the second it waits while the browser is open.
  await act(() => Bun.sleep(2200));
  expect(reads()).toBe(1);

  const user = userEvent.setup({ document });
  await user.click(button);
  // The open is followed by a read at once, which finds it open.
  await waitFor(() => expect(reads()).toBe(2));
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  // Open: about once a second from then on.
  const opened = reads();
  await act(() => Bun.sleep(2200));
  expect(reads()).toBeGreaterThanOrEqual(opened + 2);

  // Closed again (the person closed the window): back to rarely.
  state = closedState("native");
  await waitFor(
    () =>
      expect(
        (queryClient.getQueryData(browserKeys.state) as BrowserApiState).open,
      ).toBe(false),
    { timeout: 2000 },
  );
  const closed = reads();
  await act(() => Bun.sleep(2200));
  expect(reads()).toBe(closed);
}, 15_000);

for (const shows of ["native", "screen"] as const) {
  test(`a recording in the person's everyday browser puts the red dot on the ${shows === "native" ? "Desktop" : "hosted"} Browser button with no OpenBot browser open, and Stop there takes it away`, async () => {
    // Nothing of OpenBot's own is open: the server's `activity` is the one thing saying a Recorder records.
    state = { ...closedState(shows), activity: receipt("recording") };
    const { view } = draw();
    const dot = await view.findByRole("img", {
      name: /^Recording: Submit the receipt, 1:2\d$/,
    });
    expect(dot.querySelector(".bg-destructive")).not.toBeNull();
    expect(state.recorder).toBeUndefined();
    expect(
      view.getByRole(shows === "native" ? "button" : "link", {
        name: /^Browser Recording: Submit the receipt, 1:2\d$/,
      }),
    ).toBeTruthy();

    // Stopped in that browser: gone at the sidebar's next ask, which is every second while something records.
    state = closedState(shows);
    await waitFor(() => expect(dots(view)).toEqual([]), { timeout: 2000 });
  });
}

test("the dot is the server's activity, not the OpenBot browser's own report: one that records nothing lights nothing", async () => {
  // The server folds the OpenBot browser's Recorder into `activity` itself (server/src/browser/routes.ts); the sidebar
  // reads that alone, so one rule decides the dot wherever the person records.
  const { activity: _folded, ...unfolded } = recording("recording");
  state = unfolded;
  const { view } = draw();
  await view.findByRole("button", { name: "Browser" });
  await waitFor(() => expect(reads()).toBe(1));
  expect(dots(view)).toEqual([]);
});

test("on OpenBot Desktop, while a Recorder in the person's own browser is connected, a Record pressed there lights the dot within two seconds", async () => {
  state = {
    ...closedState("native"),
    real: { connected: true, browsers: ["chrome", "msedge"] },
  };
  const { view } = draw();
  await view.findByRole("button", { name: "Browser" });
  await waitFor(() => expect(reads()).toBe(1));
  // Record, pressed in the Recorder's toolbar button in their everyday Chrome: OpenBot hears of it only from the state.
  state = { ...state, activity: receipt("starting") };
  expect(
    await view.findByRole(
      "img",
      { name: "Recording: Submit the receipt, starting" },
      { timeout: 2000 },
    ),
  ).toBeTruthy();
});

test("on OpenBot Desktop a click that opened the Recorder's store page in the person's own browser says so in a short note, and they stay where they are", async () => {
  nextOpen = { real: { ok: true, opened: "store", browser: "chrome" } };
  const { view, router, visited } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  const user = userEvent.setup({ document });
  await user.click(button);
  const chrome =
    "The OpenBot Recorder's page is open in Google Chrome. Add it there to record in your own browser.";
  expect(storeOpenedSentence("chrome")).toBe(chrome);
  await waitFor(() => expect(toasts()).toEqual([chrome]));
  // A note, not an alarm: nothing went wrong.
  expect(
    [...document.querySelectorAll("[data-slot=toast-icon] svg")].map((icon) =>
      icon.classList.contains("text-destructive"),
    ),
  ).toEqual([false]);
  expect(router.state.location.pathname).toBe("/");
  expect(visited).not.toContain("/browser");
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());

  // Clicked again, in Edge this time: one note, saying the newer thing.
  nextOpen = { real: { ok: true, opened: "store", browser: "msedge" } };
  await user.click(button);
  await waitFor(() =>
    expect(toasts()).toEqual([
      "The OpenBot Recorder's page is open in Microsoft Edge. Add it there to record in your own browser.",
    ]),
  );
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());

  // It goes by itself, as a note does; only an error stays until it is closed.
  await act(() => Bun.sleep(6000));
  expect(toasts()).toEqual([]);

  // Their browser brought forward, its Recorder connected: nothing to say.
  nextOpen = { real: { ok: true, opened: "real", browser: "chrome" } };
  await user.click(button);
  await waitFor(() => expect(opens()).toBe(3));
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  expect(toasts()).toEqual([]);
  expect(router.state.location.pathname).toBe("/");
}, 15_000);

test("a store page opened after a refusal takes the refusal away and says where the page is instead", async () => {
  nextOpen = { refuse: NOT_SET_UP };
  const { view } = draw();
  const button = await view.findByRole("button", { name: "Browser" });
  const user = userEvent.setup({ document });
  await user.click(button);
  await waitFor(() => expect(toasts()).toEqual([NOT_SET_UP]));
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  nextOpen = { real: { ok: true, opened: "store", browser: "chrome" } };
  await user.click(button);
  await waitFor(() =>
    expect(toasts()).toEqual([storeOpenedSentence("chrome")]),
  );
});
