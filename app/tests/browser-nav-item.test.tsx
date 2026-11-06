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
  type LauncherState,
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { BrowserNavItem } from "@/components/browser/browser-nav-item";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { browserKeys } from "@/lib/browser/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The sidebar's Teach a Bot link, against the server's Browser routes as the contract in shared/openbot-browser.ts types
 * them: one click takes the person to the Teach a Bot page, wherever their browser shows, and opens nothing itself.
 * While any of the person's Recorders records (the server's `activity`), the link carries a red dot named for it.
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

/** Every request the link made, as `<method> <path>`. */
const requests: string[] = [];
let state: BrowserApiState;
let stateFails = false;

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

/** The server's Browser state route, as the contract has it. Anything else is recorded and not found: an open the link
 * asked for shows in `requests`. */
async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  requests.push(`${method} ${path}`);
  if (path === browserApiPaths.state && method === "GET") {
    if (stateFails)
      return Response.json({ error: "Unavailable" }, { status: 500 });
    return Response.json(state);
  }
  return new Response(null, { status: 404 });
}

const originalFetch = global.fetch;
beforeEach(() => {
  queryClient.clear();
  requests.length = 0;
  stateFails = false;
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
 * The sidebar as the app draws it, in strict mode with the app's one query client, on a router with the Teach a Bot
 * page's address, starting at home.
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
      component: () => <p>The Teach a Bot page</p>,
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

/** The names of the red dots on screen. Names rather than elements: a failed check prints what it found, and an
 * element prints the whole document's globals with it. */
const dots = (view: ReturnType<typeof draw>["view"]) =>
  view.queryAllByRole("img").map((dot) => dot.getAttribute("aria-label"));

const opens = () =>
  requests.filter((request) => request === `POST ${browserApiPaths.open}`)
    .length;
const reads = () =>
  requests.filter((request) => request === `GET ${browserApiPaths.state}`)
    .length;

for (const shows of ["native", "screen", undefined] as const) {
  test(`Teach a Bot is a link to its page${shows ? ` where the browser shows as ${shows}` : " on a server from before shows was said"}, and the click opens nothing itself`, async () => {
    const { shows: _unsaid, ...older } = closedState("native");
    state = shows ? closedState(shows) : older;
    const { view, router } = draw();
    const link = await view.findByRole("link", { name: "Teach a Bot" });
    expect(link.getAttribute("href")).toBe("/browser");
    expect(view.queryByRole("button", { name: "Teach a Bot" })).toBeNull();
    const user = userEvent.setup({ document });
    await user.click(link);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/browser"),
    );
    expect(view.getByText("The Teach a Bot page")).toBeTruthy();
    expect(opens()).toBe(0);

    // And from the keyboard, as a link: Enter follows it.
    await router.navigate({ to: "/" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    link.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/browser"),
    );
    expect(opens()).toBe(0);
  });
}

test("the sidebar has no Teach a Bot link where OpenBot cannot run a browser, or cannot say", async () => {
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
  expect(view.queryByRole("link", { name: "Teach a Bot" })).toBeNull();
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
  expect(failed.view.queryByRole("link", { name: "Teach a Bot" })).toBeNull();
});

for (const shows of ["native", "screen"] as const) {
  test(`a Record pressed in the browser itself puts a red dot named for the recording on Teach a Bot within two seconds where the browser shows as ${shows}, and Stop takes it away`, async () => {
    state = openState(shows);
    const { view } = draw();
    await view.findByRole("link", { name: "Teach a Bot" });
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
    // The link carries the recording's name with its own, for a screen reader.
    expect(
      view.getByRole("link", {
        name: /^Teach a Bot Recording: Submit the receipt, 1:2\d$/,
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
  await user.hover(view.getByRole("link", { name: /^Teach a Bot Recording/ }));
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

test("a recording in the person's everyday browser puts the red dot on Teach a Bot with no OpenBot browser open, and Stop there takes it away", async () => {
  // Nothing of OpenBot's own is open: the server's `activity` is the one thing saying a Recorder records.
  state = { ...closedState("native"), activity: receipt("recording") };
  const { view } = draw();
  const dot = await view.findByRole("img", {
    name: /^Recording: Submit the receipt, 1:2\d$/,
  });
  expect(dot.querySelector(".bg-destructive")).not.toBeNull();
  expect(state.recorder).toBeUndefined();

  // Stopped in that browser: gone at the sidebar's next ask, which is every second while something records.
  state = closedState("native");
  await waitFor(() => expect(dots(view)).toEqual([]), { timeout: 2000 });
});

test("the dot is the server's activity, not the OpenBot browser's own report: one that records nothing lights nothing", async () => {
  // The server folds the OpenBot browser's Recorder into `activity` itself (server/src/browser/routes.ts); the sidebar
  // reads that alone, so one rule decides the dot wherever the person records.
  const { activity: _folded, ...unfolded } = recording("recording");
  state = unfolded;
  const { view } = draw();
  await view.findByRole("link", { name: "Teach a Bot" });
  await waitFor(() => expect(reads()).toBe(1));
  expect(dots(view)).toEqual([]);
});
