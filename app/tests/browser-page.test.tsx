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
  browserApiPaths,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
} from "@openbot/shared/openbot-browser";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { BrowserPage } from "@/components/browser/browser-page";
import { Toaster, toast } from "@/components/ui/toast";
import type { Recognition } from "@/lib/browser/narration";
import { queryClient } from "@/query-client";
import { installChrome } from "./browser-narration.fixture";
import {
  everyLanguage,
  type OnDeviceModel,
  onDeviceModel,
  withOnDevice,
} from "./on-device-speech.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The Browser page, against the server's Browser routes as the contract in shared/openbot-browser.ts defines them.
 * Those routes are another slice's work, so they are stood in for here: every body this page sends is parsed with the
 * contract's own schemas, and every answer is a contract type. The sidebar's Browser button has its own file
 * (browser-nav-item.test.tsx).
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const PERSON_BROWSER = `person-${"ab12".repeat(8)}`;

type Write = { path: string; method: string; body: unknown };
const writes: Write[] = [];
let state: BrowserApiState;
let openAnswer: BrowserOpenResponse;
let stateFails = false;
/** Requests the server refuses, by path, with the sentence it answers: as it passes on the Recorder's own (409). */
let refusals: Partial<Record<string, string>> = {};
/** The person's actions the Recorder counts by the read after Record. */
let actionsAfterStart = 7;
/** Phrases the Recorder heard the person say itself (a native window's own narration) in the recording now running. */
let phrasesHeard = 0;
/** Phrases the page passed the Recorder in the recording now running (a hosted browser's narration). */
let phrasesPassed = 0;
/** Whether New tab opens one, in front, as the computer does. Off where a case reads the bar it started with. */
let tabsOpen = false;
/** The person's narration choice as their preferences keep it: on, as for someone who chose it, unless a test says. */
let narrationChoice: "on" | "off" | null = "on";
/** While set, opening the browser waits for it, as a browser that takes seconds to launch does. */
let opening: Promise<void> | null = null;
/** While set, reading the person's preferences waits for it; `preferencesFail` makes the read fail instead. */
let preferencesHeld: Promise<void> | null = null;
let preferencesFail = false;

function nativeState(): BrowserApiState {
  return {
    available: true,
    shows: "native",
    computerId: PERSON_BROWSER,
    open: true,
    browser: "chrome",
    window: "native",
    narration: "own",
    recorder: { connected: true, phase: "idle", actions: 0, narration: "own" },
    tabs: [],
  };
}

function screenState(): BrowserApiState {
  return {
    available: true,
    shows: "screen",
    computerId: PERSON_BROWSER,
    open: true,
    browser: "chromium",
    window: "screen",
    narration: "external",
    recorder: {
      connected: true,
      phase: "idle",
      actions: 0,
      narration: "external",
    },
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example Domain",
        active: true,
      },
      // An empty tab exactly as the computer reports one: the browser titles a page that has no title with its
      // address. The strip showed "about:blank" for it in the third end-to-end run.
      { id: "tab-2", url: "about:blank", title: "about:blank", active: false },
    ],
  };
}

function answerFor(window: "native" | "screen"): BrowserOpenResponse {
  return {
    ok: true,
    computerId: PERSON_BROWSER,
    browser: window === "native" ? "chrome" : "chromium",
    window,
    narration: window === "native" ? "own" : "external",
  };
}

/** The server's Browser routes, as the contract has them. A body the contract refuses is a 400, as Zod would make it. */
async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (method !== "GET") writes.push({ path, method, body });
  const refuse = () =>
    Response.json({ error: "Invalid request" }, { status: 400 });
  const refusal = refusals[path];
  if (refusal && method === "POST")
    return Response.json({ error: refusal }, { status: 409 });
  if (path === "/api/me")
    return Response.json({
      user: {
        id: "ada",
        email: "ada@example.com",
        role: "user",
        onboarding: null,
      },
    });
  if (path === "/api/settings/preferences") {
    if (method === "GET") {
      await preferencesHeld;
      if (preferencesFail)
        return Response.json({ error: "Unavailable" }, { status: 500 });
    }
    // As the server's own route takes it: one preference at a time, merged into the rest.
    if (method === "PATCH" && body && "narration" in body)
      narrationChoice = body.narration;
    return Response.json({
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: false,
        narration: narrationChoice,
      },
    });
  }
  if (path === browserApiPaths.state && method === "GET") {
    if (stateFails)
      return Response.json({ error: "Unavailable" }, { status: 500 });
    return Response.json(state);
  }
  if (path === browserApiPaths.open && method === "POST") {
    if (body !== undefined) return refuse();
    await opening;
    state = { ...state, open: true };
    return Response.json(openAnswer);
  }
  if (path === browserApiPaths.recording && method === "POST") {
    const request = browserRecordingRequestSchema.safeParse(body);
    if (!request.success || !state.recorder) return refuse();
    state = {
      ...state,
      recorder:
        request.data.action === "start"
          ? {
              ...state.recorder,
              phase: "recording",
              title: request.data.title,
              recordingId: "rec-1",
              // As if the person had been at it for 42 seconds and seven actions by the next read.
              startedAt: Date.now() - 42_000,
              actions: actionsAfterStart,
            }
          : {
              ...state.recorder,
              phase: "idle",
              actions: 0,
              // The Recorder names the recording Stop ended, once it went to Intelligence, with what it held: the
              // actions its badge counted and the phrases it kept.
              lastStopped: {
                recordingId: state.recorder.recordingId ?? "rec-1",
                title: state.recorder.title ?? "",
                stoppedAt: Date.now(),
                actions: state.recorder.actions,
                phrases: phrasesHeard + phrasesPassed,
              },
            },
    };
    if (request.data.action === "start") phrasesPassed = 0;
    return Response.json(state);
  }
  if (path === browserApiPaths.narration && method === "POST") {
    const narrated = browserNarrationRequestSchema.safeParse(body);
    if (!narrated.success) return refuse();
    if ("text" in narrated.data) phrasesPassed += 1;
    return Response.json({ ok: true });
  }
  if (path === browserApiPaths.tabs && method === "POST") {
    const request = browserTabsRequestSchema.safeParse(body);
    if (!request.success) return refuse();
    // A close, as the computer makes one: the tab goes, and when it was the one in front the person's newest tab comes
    // forward (agent-computer's profiles.ts, `retarget`). An activate brings the tab forward. A new tab opens empty, in
    // front, where a case asks for it (`tabsOpen`).
    if (request.data.action === "close") {
      const closing = request.data.tabId;
      const left = state.tabs.filter((tab) => tab.id !== closing);
      const front = state.tabs.find((tab) => tab.id === closing)?.active
        ? left.at(-1)?.id
        : left.find((tab) => tab.active)?.id;
      state = {
        ...state,
        tabs: left.map((tab) => ({ ...tab, active: tab.id === front })),
      };
    } else if (request.data.action === "activate") {
      const front = request.data.tabId;
      state = {
        ...state,
        tabs: state.tabs.map((tab) => ({ ...tab, active: tab.id === front })),
      };
    } else if (tabsOpen && request.data.action === "new")
      state = {
        ...state,
        tabs: [
          ...state.tabs.map((tab) => ({ ...tab, active: false })),
          {
            id: "tab-new",
            url: "about:blank",
            title: "about:blank",
            active: true,
          },
        ],
      };
    return Response.json(state);
  }
  if (path === browserApiPaths.clear && method === "POST") {
    if (body !== undefined) return refuse();
    // As the server clears it: the computer wipes the browser, and one that was open opens again fresh, its Recorder
    // connected anew, one empty tab and nothing recording.
    state = {
      ...state,
      recorder: {
        connected: true,
        phase: "idle",
        actions: 0,
        narration: state.narration ?? "external",
      },
      tabs: [
        {
          id: "tab-fresh",
          url: "about:blank",
          title: "about:blank",
          active: true,
        },
      ],
    };
    return Response.json(state);
  }
  if (path === browserApiPaths.navigate && method === "POST") {
    return browserNavigateRequestSchema.safeParse(body).success
      ? Response.json(state)
      : refuse();
  }
  return new Response(null, { status: 404 });
}

/** The live screen's socket, which the page opens to the person's browser and nothing here answers. */
class QuietSocket {
  static urls: string[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(url: string) {
    QuietSocket.urls.push(url);
  }
  send() {}
  close() {}
}

/**
 * The live screen's socket to a browser that is there: it opens, and keeps what the page sends it. The screen takes
 * input only once its socket is open, so only with this one does the page meet the keyboard as a person's does.
 */
class LiveSocket {
  static latest: LiveSocket | undefined;
  static readonly OPEN = 1;
  readyState = LiveSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  constructor(_url: string) {
    LiveSocket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
}

/** What a screen reader calls the person's browser on the Browser page. */
const SCREEN =
  "Your browser. Click it to type into it, and press Escape to leave it.";

const originalFetch = global.fetch;
const originalSocket = globalThis.WebSocket;
const speechGlobals = globalThis as {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

beforeEach(() => {
  queryClient.clear();
  writes.length = 0;
  stateFails = false;
  refusals = {};
  actionsAfterStart = 7;
  phrasesHeard = 0;
  phrasesPassed = 0;
  tabsOpen = false;
  narrationChoice = "on";
  opening = null;
  preferencesHeld = null;
  preferencesFail = false;
  state = nativeState();
  openAnswer = answerFor("native");
  QuietSocket.urls = [];
  global.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      server(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  delete speechGlobals.SpeechRecognition;
  delete speechGlobals.webkitSpeechRecognition;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  delete speechGlobals.SpeechRecognition;
  delete speechGlobals.webkitSpeechRecognition;
});

/** Drawn as the app draws it: strict mode, the app's one query client, a router, and its toasts. */
function draw(ui: ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <>
          {ui}
          <Toaster />
        </>
      ),
    }),
  });
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

const opens = () =>
  writes.filter((write) => write.path === browserApiPaths.open).length;

test("on OpenBot Desktop the page opens the browser once, says it is a window on the desktop, and brings it forward", async () => {
  const view = draw(<BrowserPage />);
  expect(await view.findByText("Google Chrome")).toBeTruthy();
  expect(
    view.getByText("Open in its own window on your desktop."),
  ).toBeTruthy();
  // The person's narration choice, which the next Record passes on to the Recorder in their browser.
  expect(
    await view.findByText(
      /^On\. The Recorder in your browser listens to your microphone while you record/,
    ),
  ).toBeTruthy();
  // Strict mode runs the opening effect twice; the browser is still opened once.
  expect(opens()).toBe(1);
  // No live screen: the browser is its own window.
  expect(QuietSocket.urls).toEqual([]);

  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Bring to front" }));
  await waitFor(() => expect(opens()).toBe(2));
  expect(view.getByText("Google Chrome")).toBeTruthy();
});

test("on OpenBot Desktop Record starts a recording named for the task, which shows its time and actions until Stop", async () => {
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  const name = await view.findByRole("textbox", { name: "Task name" });
  const record = view.getByRole("button", { name: "Record" });
  expect((record as HTMLButtonElement).disabled).toBe(true);
  await user.type(name, "Submit an expense report");
  await user.click(record);
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: "/api/browser/recording",
      method: "POST",
      body: {
        action: "start",
        title: "Submit an expense report",
        language: navigator.language,
        // The person chose to narrate: the Recorder opens the microphone for this recording.
        narrate: true,
      },
    }),
  );
  expect(await view.findByText("Submit an expense report")).toBeTruthy();
  expect(view.getByRole("timer").textContent).toMatch(/^0:4\d · 7 actions$/);

  await user.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(writes.at(-1)).toEqual({
      path: "/api/browser/recording",
      method: "POST",
      body: { action: "stop" },
    }),
  );
  expect(await view.findByRole("textbox", { name: "Task name" })).toBeTruthy();
  // Stop says where the recording went and what it held, by its name, until the next one starts.
  const saved = await view.findByRole("status");
  expect(saved.textContent).toBe(
    "Submit an expense reportSaved to your Learning space: 7 actions.",
  );
});

/** What the page says Stop did with the recording: the status that names it saved, or that nothing was recorded. */
async function stopSays(view: ReturnType<typeof draw>): Promise<string> {
  let said = "";
  await waitFor(async () => {
    const statuses = await view.findAllByRole("status");
    said =
      statuses
        .map((status) => status.textContent ?? "")
        .find((text) => /Saved|Nothing was recorded/.test(text)) ?? "";
    expect(said).not.toBe("");
  });
  return said;
}

/** Records a task named `title` on the page and stops it, once the page has read the recording running. */
async function recordAndStop(
  view: ReturnType<typeof draw>,
  title: string,
  beforeStop: () => void = () => {},
) {
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    title,
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await view.findByRole("timer");
  beforeStop();
  await user.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(writes.at(-1)).toEqual({
      path: "/api/browser/recording",
      method: "POST",
      body: { action: "stop" },
    }),
  );
}

test("Stop on a recording that held no actions says nothing was recorded and why, never that it was saved, on both shapes", async () => {
  // The fourth end-to-end run: the person worked in a tab the recording did not follow, the trajectory reached
  // Intelligence with no steps, and the page said it was saved to their Learning space. A recording now follows every
  // tab the person uses, so the page says what a recording holds rather than which tab it followed.
  for (const shape of ["native", "screen"] as const) {
    cleanup();
    queryClient.clear();
    writes.length = 0;
    state = shape === "native" ? nativeState() : screenState();
    openAnswer = answerFor(shape);
    actionsAfterStart = 0;
    const view = draw(<BrowserPage />);
    await recordAndStop(view, "Look up Ada Lovelace");
    expect(await stopSays(view)).toBe(
      shape === "native"
        ? "Look up Ada LovelaceNothing was recorded. The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out."
        : "Nothing was recorded in “Look up Ada Lovelace”. The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out.",
    );
    expect(view.queryByText(/Saved/)).toBeNull();
  }
});

test("a recording of narration alone is saved, with its phrases, never said to hold nothing, on both shapes", async () => {
  // The fifth end-to-end run: three narrated phrases and no clicks reached Intelligence, and the page said nothing was
  // recorded, from the actions it had read while the recording ran.
  for (const shape of ["native", "screen"] as const) {
    cleanup();
    queryClient.clear();
    writes.length = 0;
    state = shape === "native" ? nativeState() : screenState();
    openAnswer = answerFor(shape);
    actionsAfterStart = 0;
    // Three phrases the Recorder kept, whether it heard them itself or the page passed them in.
    phrasesHeard = 3;
    const view = draw(<BrowserPage />);
    await recordAndStop(view, "Talk it through");
    expect(await stopSays(view)).toBe(
      shape === "native"
        ? "Talk it throughSaved to your Learning space: 0 actions and 3 narrated phrases."
        : "Saved “Talk it through” to your Learning space: 0 actions and 3 narrated phrases.",
    );
    expect(view.queryByText(/Nothing was recorded/)).toBeNull();
  }
});

test("after a reload the page says what the last recording held as the Recorder reports it, on both shapes", async () => {
  // The page never saw these recordings running: it was loaded again after Stop. It used to take any of them as saved.
  for (const shape of ["native", "screen"] as const) {
    for (const [held, says] of [
      [
        { actions: 0, phrases: 0 },
        shape === "native"
          ? "Look up Ada LovelaceNothing was recorded. The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out."
          : "Nothing was recorded in “Look up Ada Lovelace”. The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out.",
      ],
      [
        { actions: 1, phrases: 2 },
        shape === "native"
          ? "Look up Ada LovelaceSaved to your Learning space: 1 action and 2 narrated phrases."
          : "Saved “Look up Ada Lovelace” to your Learning space: 1 action and 2 narrated phrases.",
      ],
    ] as const) {
      cleanup();
      queryClient.clear();
      const base = shape === "native" ? nativeState() : screenState();
      state = {
        ...base,
        recorder: {
          ...(base.recorder as NonNullable<BrowserApiState["recorder"]>),
          lastStopped: {
            recordingId: "rec-0",
            title: "Look up Ada Lovelace",
            stoppedAt: Date.now() - 60_000,
            ...held,
          },
        },
      };
      openAnswer = answerFor(shape);
      const view = draw(<BrowserPage />);
      expect(await stopSays(view)).toBe(says);
    }
  }
});

test("an action the page has not read yet when Stop is pressed still counts: the recording is said to be saved", async () => {
  for (const shape of ["native", "screen"] as const) {
    cleanup();
    queryClient.clear();
    writes.length = 0;
    state = shape === "native" ? nativeState() : screenState();
    openAnswer = answerFor(shape);
    actionsAfterStart = 0;
    const view = draw(<BrowserPage />);
    // The person acts in their browser a moment before Stop, after the page's last read.
    await recordAndStop(view, "Refund an order", () => {
      state = {
        ...state,
        recorder: {
          ...(state.recorder as NonNullable<BrowserApiState["recorder"]>),
          actions: 1,
        },
      };
    });
    expect(await stopSays(view)).toBe(
      shape === "native"
        ? "Refund an orderSaved to your Learning space: 1 action."
        : "Saved “Refund an order” to your Learning space: 1 action.",
    );
  }
});

test("Record is offered while the Recorder is disconnected: the server connects it first", async () => {
  // Disconnecting the OpenBot browser in Settings leaves the Recorder signed out until something asks again; Record is
  // that ask, and the server reconnects the browser before it starts.
  state = {
    ...nativeState(),
    recorder: { connected: false, phase: "idle", actions: 0, narration: "own" },
  };
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Refund an order",
  );
  expect(view.queryByText("The Recorder is still connecting.")).toBeNull();
  await user.click(view.getByRole("button", { name: "Record" }));
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        path: "/api/browser/recording",
        body: expect.objectContaining({ action: "start" }),
      }),
    ),
  );
});

test("on hosted OpenBot the page is the browser: its tabs, its address and its live screen, driven at once", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  const screen = await view.findByLabelText(SCREEN);
  expect(screen.tagName).toBe("CANVAS");
  // Strict mode opens and closes one first; every socket is to the person's own browser.
  expect(QuietSocket.urls.length).toBeGreaterThan(0);
  for (const url of QuietSocket.urls)
    expect(url).toEndWith(`/api/computers/${PERSON_BROWSER}/stream`);
  expect(opens()).toBe(1);

  const tabs = within(view.getByRole("tablist", { name: "Tabs" }));
  const [first, second] = tabs.getAllByRole("tab");
  expect(first?.textContent).toBe("Example Domain");
  expect(first?.getAttribute("aria-selected")).toBe("true");
  expect(second?.textContent).toBe("New tab");
  // The tab that shows controls the panel below, which it names: the address bar and the screen are in it.
  const panel = view.getByRole("tabpanel", { name: "Example Domain" });
  expect(first?.getAttribute("aria-controls")).toBe(panel.id);
  const address = within(panel).getByRole("textbox", { name: "Address" });
  expect((address as HTMLInputElement).value).toBe("https://example.com/");

  const user = userEvent.setup({ document });
  if (second) await user.click(second);
  await user.click(view.getByRole("button", { name: "New tab" }));
  // Delete closes the focused tab; its close button is the mouse's way to the same thing.
  first?.focus();
  await user.keyboard("{Delete}");
  await user.click(view.getByRole("button", { name: "Back" }));
  await user.click(view.getByRole("button", { name: "Reload" }));
  // The bar of the tab that shows now: switching tabs starts it again from that tab's own address.
  const bar = view.getByRole("textbox", { name: "Address" });
  await user.clear(bar);
  await user.type(bar, "openbot.ai{Enter}");
  await user.type(bar, "how to file an expense report{Enter}");
  await waitFor(() =>
    expect(
      writes.filter((write) => write.path !== "/api/browser/open"),
    ).toEqual([
      {
        path: "/api/browser/tabs",
        method: "POST",
        body: { action: "activate", tabId: "tab-2" },
      },
      { path: "/api/browser/tabs", method: "POST", body: { action: "new" } },
      {
        path: "/api/browser/tabs",
        method: "POST",
        body: { action: "close", tabId: "tab-1" },
      },
      {
        path: "/api/browser/navigate",
        method: "POST",
        body: { action: "back" },
      },
      {
        path: "/api/browser/navigate",
        method: "POST",
        body: { action: "reload" },
      },
      {
        path: "/api/browser/navigate",
        method: "POST",
        body: { url: "https://openbot.ai" },
      },
      {
        path: "/api/browser/navigate",
        method: "POST",
        body: {
          url: "https://www.google.com/search?q=how%20to%20file%20an%20expense%20report",
        },
      },
    ]),
  );
});

test("on hosted OpenBot the page narrates a recording, and Stop sends the phrase being said before the recording ends", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  const recognitions = installChrome();
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  // Listening starts with the recording, in the language the recording was started in.
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));
  const listening = recognitions.at(-1);
  expect(listening).toMatchObject({
    lang: navigator.language,
    continuous: true,
    interimResults: true,
  });
  expect(view.getByRole("switch", { name: "Narration" })).toBeTruthy();

  await user.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(writes.at(-1)).toEqual({
      path: "/api/browser/recording",
      method: "POST",
      body: { action: "stop" },
    }),
  );
  const narration = writes.filter(
    (write) => write.path === "/api/browser/narration",
  );
  // The Recorder is told the phrase began as its first words came back, then the phrase, then that nothing more is
  // being said, in that order and one at a time, each stamped with this computer's clock as it left.
  expect(
    narration.map(({ body }) => {
      const { sentAt: _sent, ...rest } = body as { sentAt: number };
      return "text" in rest ? { text: (rest as { text: string }).text } : rest;
    }),
  ).toEqual([
    { speaking: true, since: expect.any(Number) },
    { text: "I am opening the expenses page" },
    { speaking: false },
  ]);
  const [began, phrase] = narration.map(
    (write) =>
      write.body as {
        since?: number;
        startedAt?: number;
        endedAt?: number;
        sentAt: number;
      },
  );
  // The phrase began when the Recorder was told it did: it holds the steps from then until the phrase arrives.
  expect(phrase?.startedAt).toBe(began?.since);
  expect(phrase?.startedAt ?? 0).toBeLessThanOrEqual(phrase?.endedAt ?? 0);
  for (const write of narration) {
    const sentAt = (write.body as { sentAt: number }).sentAt;
    expect(Math.abs(Date.now() - sentAt)).toBeLessThan(10_000);
  }
  expect(began?.sentAt ?? 0).toBeLessThanOrEqual(phrase?.sentAt ?? 0);
  // Everything reached the server before the recording was stopped.
  expect(writes.indexOf(narration.at(-1) as Write)).toBeLessThan(
    writes.findLastIndex((write) => write.path === "/api/browser/recording"),
  );
  // Then the page says where the recording went, and what it held: the phrase it narrated among them.
  expect(
    await view.findByText(
      "Saved “Submit an expense report” to your Learning space: 7 actions and 1 narrated phrase.",
    ),
  ).toBeTruthy();
});

test("on hosted OpenBot a narration the Recorder refused says why, beside the narration switch", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  refusals = {
    [browserApiPaths.narration]: "This browser hears your voice itself.",
  };
  const recognitions = installChrome();
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));
  expect(
    await view.findByText(
      "Some of what you said didn't reach the Recorder. This browser hears your voice itself.",
    ),
  ).toBeTruthy();
});

test("on hosted OpenBot narration that cannot hear the person shows its switch off, and turning it on tries again", async () => {
  // The fourth end-to-end run: in a browser with no microphone the page said narration was off while its switch read on.
  for (const [error, sentence] of [
    [
      "not-allowed",
      "OpenBot can't use your microphone, so narration is off. Allow the microphone for this site, then turn narration on again. Recording still works.",
    ],
    [
      "audio-capture",
      "No microphone was found, or another app is using it. Recording still works.",
    ],
  ] as const) {
    cleanup();
    queryClient.clear();
    writes.length = 0;
    state = screenState();
    openAnswer = answerFor("screen");
    const chrome = installRefusingChrome();
    chrome.error = error;
    const view = draw(<BrowserPage />);
    const user = userEvent.setup({ document });
    const toggle = await view.findByRole("switch", { name: "Narration" });
    // Before a recording narration is on, as the person chose and nothing has failed yet.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    await user.type(
      view.getByRole("textbox", { name: "Task name" }),
      "Submit an expense report",
    );
    await user.click(view.getByRole("button", { name: "Record" }));
    expect(await view.findByText(sentence)).toBeTruthy();
    expect(
      view
        .getByRole("switch", { name: "Narration" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    // The person allows the microphone, or plugs one in, and turns narration on: it listens again.
    chrome.error = null;
    const listened = chrome.listening;
    await user.click(view.getByRole("switch", { name: "Narration" }));
    await waitFor(() => expect(chrome.listening).toBe(listened + 1));
    expect(
      view
        .getByRole("switch", { name: "Narration" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(view.queryByText(sentence)).toBeNull();
  }
});

test("on hosted OpenBot narration whose speech service cannot be reached stays on: it tries again by itself", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  const chrome = installRefusingChrome();
  chrome.error = "network";
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  expect(
    await view.findByText(
      "Can't reach this browser's speech service. Narration tries again in a moment.",
    ),
  ).toBeTruthy();
  expect(
    view
      .getByRole("switch", { name: "Narration" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("Record and Stop the server refused say the server's sentence where the person pressed them, on both shapes", async () => {
  for (const shape of ["native", "screen"] as const) {
    cleanup();
    queryClient.clear();
    writes.length = 0;
    state = shape === "native" ? nativeState() : screenState();
    openAnswer = answerFor(shape);
    refusals = {
      [browserApiPaths.recording]:
        "This browser is no longer connected to OpenBot. Open it from OpenBot again.",
    };
    const view = draw(<BrowserPage />);
    const user = userEvent.setup({ document });
    await user.type(
      await view.findByRole("textbox", { name: "Task name" }),
      "Refund an order",
    );
    await user.click(view.getByRole("button", { name: "Record" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "This browser is no longer connected to OpenBot. Open it from OpenBot again.",
    );

    // A recording the Recorder will not stop.
    refusals = {
      [browserApiPaths.recording]: "The Recorder could not do that. Try again.",
    };
    state = {
      ...state,
      recorder: {
        ...(state.recorder as NonNullable<BrowserApiState["recorder"]>),
        phase: "recording",
        title: "Refund an order",
        recordingId: "rec-2",
        startedAt: Date.now() - 5_000,
        actions: 2,
      },
    };
    await queryClient.invalidateQueries();
    await user.click(await view.findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "The Recorder could not do that. Try again.",
      ),
    );
  }
});

test("on hosted OpenBot a refused Record is shown even after a tab that would not close", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  refusals = { [browserApiPaths.tabs]: "There is no such tab." };
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  // Delete closes the focused tab, the tabs pattern's key for it.
  (await view.findByRole("tab", { name: "Example Domain" })).focus();
  await user.keyboard("{Delete}");
  expect((await view.findByRole("alert")).textContent).toBe(
    "There is no such tab.",
  );
  refusals = {
    [browserApiPaths.recording]: "A recording is already running.",
  };
  await user.type(
    view.getByRole("textbox", { name: "Task name" }),
    "Refund an order",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe(
      "A recording is already running.",
    ),
  );
});

test("on OpenBot Desktop the narration row says what the Recorder hears, as it reports it", async () => {
  const recorder = (voice: NonNullable<BrowserApiState["recorder"]>["voice"]) =>
    ({
      connected: true,
      phase: voice === "off" ? "idle" : "recording",
      actions: 0,
      narration: "own",
      voice,
      ...(voice === "off"
        ? {}
        : {
            title: "Submit an expense report",
            recordingId: "rec-1",
            startedAt: Date.now(),
          }),
    }) satisfies BrowserApiState["recorder"];
  state = { ...nativeState(), recorder: recorder("off") };
  const view = draw(<BrowserPage />);
  // While nothing records, the row is the person's choice.
  expect(
    await view.findByText(
      "On. The Recorder in your browser listens to your microphone while you record, and turns your speech into text on your computer.",
    ),
  ).toBeTruthy();
  for (const [voice, sentence] of [
    ["listening", "Listening. Say what you're doing as you go."],
    [
      "muted",
      "Muted in the Recorder, so what you say isn't recorded. Turn it on again from the Recorder's button in your browser's toolbar.",
    ],
    [
      "unavailable",
      "The Recorder can't hear your microphone, so what you say isn't recorded. The Recorder's button in your browser's toolbar says why. Recording still works.",
    ],
  ] as const) {
    state = { ...nativeState(), recorder: recorder(voice) };
    await queryClient.invalidateQueries();
    expect(await view.findByText(sentence)).toBeTruthy();
  }
});

test("on hosted OpenBot in a browser with no speech recognition, the page says narration is unavailable and Record still works", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  expect(
    await view.findByText(
      "Narration isn't available in this browser, so what you say isn't recorded. Recording still works.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("switch", { name: "Narration" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "Task name" }),
    "Refund an order",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        path: "/api/browser/recording",
        body: expect.objectContaining({ action: "start" }),
      }),
    ),
  );
});

// ---- Narration only by the person's choice, on their own computer: a microphone is opened for nobody who did not ask
// for it, and what they say is turned into text without leaving it ---------------------------------------------------

const preferenceWrites = () =>
  writes.filter((write) => write.path === "/api/settings/preferences");
const starts = () =>
  writes.filter(
    (write) =>
      write.path === browserApiPaths.recording &&
      (write.body as { action?: string }).action === "start",
  );

test("Record asks whether to narrate before the first recording, keeps the answer, and tells the Recorder, on OpenBot Desktop", async () => {
  narrationChoice = null;
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  expect(
    await view.findByText(
      "Not chosen yet. Record asks before your first recording, and the microphone stays closed until you say yes.",
    ),
  ).toBeTruthy();
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  const question = await view.findByRole("dialog", {
    name: "Narrate while you record?",
  });
  expect(starts()).toEqual([]);
  expect(question.textContent).toContain(
    "Your browser turns your speech into text on your own computer.",
  );
  await user.click(
    within(question).getByRole("button", { name: "Record without narration" }),
  );
  await waitFor(() => expect(starts()).toHaveLength(1));
  // The answer is kept, and the Recorder opens no microphone for this recording.
  expect(preferenceWrites()).toEqual([
    {
      path: "/api/settings/preferences",
      method: "PATCH",
      body: { narration: "off" },
    },
  ]);
  expect(starts()[0]?.body).toMatchObject({ narrate: false });
  expect(view.queryByRole("dialog")).toBeNull();
});

test("a choice still being read when Record is pressed is read, not asked again", async () => {
  // The person chose narration on long ago. Their preferences took a moment to arrive, and a Record pressed meanwhile
  // asked them again, as if they never had.
  narrationChoice = "on";
  let arrive = () => {};
  preferencesHeld = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await settleReactWork();
  expect(
    view.queryByRole("dialog", { name: "Narrate while you record?" }),
  ).toBeNull();
  expect(starts()).toEqual([]);
  arrive();
  await waitFor(() => expect(starts()).toHaveLength(1));
  expect(starts()[0]?.body).toMatchObject({ narrate: true });
  expect(
    view.queryByRole("dialog", { name: "Narrate while you record?" }),
  ).toBeNull();
  expect(preferenceWrites()).toEqual([]);
});

test("a choice that cannot be read records without narration and asks nothing", async () => {
  narrationChoice = "on";
  preferencesFail = true;
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(starts()).toHaveLength(1));
  // The microphone stays closed, and the choice is left as the person made it.
  expect(starts()[0]?.body).toMatchObject({ narrate: false });
  expect(
    view.queryByRole("dialog", { name: "Narrate while you record?" }),
  ).toBeNull();
  expect(preferenceWrites()).toEqual([]);
});

test("on hosted OpenBot a yes to the narration question listens, on the person's computer, and the bar says it is listening", async () => {
  narrationChoice = null;
  state = screenState();
  openAnswer = answerFor("screen");
  const recognitions = installChrome();
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  // Nobody chose yet: the switch is off, and nothing listens.
  const toggle = await view.findByRole("switch", { name: "Narration" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await user.type(
    view.getByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  const question = await view.findByRole("dialog", {
    name: "Narrate while you record?",
  });
  expect(recognitions).toHaveLength(0);
  await user.click(
    within(question).getByRole("button", { name: "Record with narration" }),
  );
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));
  expect(recognitions.at(-1)?.processLocally).toBe(true);
  expect(preferenceWrites().map((write) => write.body)).toEqual([
    { narration: "on" },
  ]);
  expect(starts()[0]?.body).toMatchObject({ narrate: true });
  // An open microphone is said in so many words beside the switch.
  expect((await view.findByText("Listening")).getAttribute("role")).toBe(
    "status",
  );
});

test("on hosted OpenBot a person who chose not to narrate is never listened to, and turning the switch on keeps the new choice", async () => {
  narrationChoice = "off";
  state = screenState();
  openAnswer = answerFor("screen");
  const recognitions = installChrome();
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(starts()).toHaveLength(1));
  // No question: they answered it before. No microphone either.
  expect(view.queryByRole("dialog")).toBeNull();
  expect(starts()[0]?.body).toMatchObject({ narrate: false });
  await settleReactWork();
  expect(recognitions).toHaveLength(0);
  expect(view.queryByText("Listening")).toBeNull();

  await user.click(view.getByRole("switch", { name: "Narration" }));
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));
  expect(preferenceWrites().map((write) => write.body)).toEqual([
    { narration: "on" },
  ]);
});

test("on hosted OpenBot a language still to be downloaded is asked for on the switch's click, and narration waits for it", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  // Chrome answers downloadable for a language this page has not asked for yet, and downloads only on a click.
  const model = onDeviceModel({ [navigator.language]: "downloadable" });
  const recognitions = installChrome(model);
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  expect(
    await view.findByText(
      /^Your browser has to download its .+ speech recognition to your computer first\. Turn narration on to download it\./,
    ),
  ).toBeTruthy();
  expect(recognitions).toHaveLength(0);
  const toggle = view.getByRole("switch", { name: "Narration" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  document.addEventListener(
    "click",
    () => {
      model.activation = true;
    },
    { capture: true, once: true },
  );
  await user.click(toggle);
  expect(model.installs).toEqual([navigator.language]);
  expect(
    await view.findByText(
      /^Your browser is downloading its .+ speech recognition to your computer\. Narration starts when it's ready\./,
    ),
  ).toBeTruthy();
  expect(recognitions).toHaveLength(0);
  model.finishDownloads();
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true), {
    timeout: 5_000,
  });
}, 15_000);

test("on hosted OpenBot a browser that cannot keep speech on the computer never listens, and says why", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  const recognitions = installChrome(null);
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Task name" }),
    "Submit an expense report",
  );
  await user.click(view.getByRole("button", { name: "Record" }));
  expect(
    await view.findByText(
      "This browser can't turn speech into text on your computer, and OpenBot sends your voice nowhere else, so narration is off. Recording still works.",
    ),
  ).toBeTruthy();
  expect(recognitions).toHaveLength(0);
});

test("the tab strip is WAI-ARIA tabs: one stop in the Tab order, arrows, Home and End move between tabs, Enter switches", async () => {
  state = {
    ...screenState(),
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example Domain",
        active: true,
      },
      {
        id: "tab-2",
        url: "https://docs.example.com/",
        title: "Docs",
        active: false,
      },
      {
        id: "tab-3",
        url: "https://mail.example.com/",
        title: "Mail",
        active: false,
      },
    ],
  };
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  const [first, second, third] = within(
    await view.findByRole("tablist", { name: "Tabs" }),
  ).getAllByRole("tab");
  // Only the tab that shows is in the Tab order.
  expect(
    [first, second, third].map((tab) => tab?.getAttribute("tabindex")),
  ).toEqual(["0", "-1", "-1"]);
  first?.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(second as Element);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(third as Element);
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(first as Element);
  await user.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(third as Element);
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(first as Element);
  // Moving switches nothing: a switch is a request to the computer, so it waits for Enter.
  expect(writes.filter((write) => write.path === browserApiPaths.tabs)).toEqual(
    [],
  );
  await user.keyboard("{ArrowRight}{Enter}");
  await waitFor(() =>
    expect(
      writes.filter((write) => write.path === browserApiPaths.tabs),
    ).toEqual([
      {
        path: browserApiPaths.tabs,
        method: "POST",
        body: { action: "activate", tabId: "tab-2" },
      },
    ]),
  );
});

/*
 * The same keys with the live screen connected, as it is for a person: the end-to-end run found that none of them did
 * anything. The screen took every key on the window that was not aimed at a text field, so the tabs never heard their
 * arrows, Home, End or Delete, no button took Enter or Space, and Tab left nothing; the keys went to the person's
 * browser instead. Now the screen takes the keyboard only once it is clicked, and Escape gives it back.
 */
test("with the live screen connected, the page's controls keep their keys, and the screen takes them once clicked", async () => {
  state = {
    ...screenState(),
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example Domain",
        active: true,
      },
      {
        id: "tab-2",
        url: "https://docs.example.com/",
        title: "Docs",
        active: false,
      },
      {
        id: "tab-3",
        url: "https://mail.example.com/",
        title: "Mail",
        active: false,
      },
    ],
  };
  openAnswer = answerFor("screen");
  globalThis.WebSocket = LiveSocket as unknown as typeof WebSocket;
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  const screen = await view.findByLabelText(SCREEN);
  await waitFor(() =>
    expect(screen.getAttribute("data-connected")).toBe("true"),
  );
  const [first, second, third] = within(
    view.getByRole("tablist", { name: "Tabs" }),
  ).getAllByRole("tab");

  first?.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(second as Element);
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(third as Element);
  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(first as Element);
  await user.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(third as Element);
  // Enter switches to the focused tab, and Delete closes it: the focus goes to the tab the browser shows next.
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(third?.getAttribute("aria-selected")).toBe("true"),
  );
  await user.keyboard("{Delete}");
  await waitFor(() => expect(document.activeElement).toBe(second as Element));
  // Tab leaves the strip for the next control, which Space presses.
  await user.tab();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "New tab" }),
  );
  await user.keyboard(" ");
  await waitFor(() =>
    expect(
      writes.filter((write) => write.path === browserApiPaths.tabs),
    ).toEqual([
      {
        path: browserApiPaths.tabs,
        method: "POST",
        body: { action: "activate", tabId: "tab-3" },
      },
      {
        path: browserApiPaths.tabs,
        method: "POST",
        body: { action: "close", tabId: "tab-3" },
      },
      { path: browserApiPaths.tabs, method: "POST", body: { action: "new" } },
    ]),
  );
  // None of it reached the person's browser.
  const socket = LiveSocket.latest as LiveSocket;
  expect(socket.sent).toEqual([]);

  // A click on the screen gives it the keyboard: what is typed next goes to the page on it, with no second click.
  await user.click(screen);
  expect(document.activeElement).toBe(screen);
  await user.keyboard("a{ArrowLeft}");
  expect(socket.sent.map((message) => [message.event, message.key])).toEqual([
    ["down", "a"],
    ["up", "a"],
    ["down", "ArrowLeft"],
    ["up", "ArrowLeft"],
  ]);
  // Escape gives the keyboard back to the page, and is not sent.
  await user.keyboard("{Escape}");
  expect(document.activeElement).not.toBe(screen);
  await user.keyboard("b");
  expect(socket.sent).toHaveLength(4);

  // An address typed into the bar goes to the page that opens, as Chrome's address bar does: the screen has the keys.
  const address = view.getByRole("textbox", { name: "Address" });
  await user.clear(address);
  await user.type(address, "openbot.ai{Enter}");
  expect(document.activeElement).toBe(screen);
});

/** What the server says of a person's browser that is there and not answering, on an OpenBot with sign-in. */
const NOT_ANSWERING =
  "Your browser isn't answering. If it doesn't come back soon, ask an admin for help.";

test("Delete on the tab that shows puts the focus on the tab the browser shows next, not on its neighbour", async () => {
  // The computer brings the person's newest tab forward when the one in front closes. The strip put the focus on the
  // closed tab's neighbour, so it sat on one tab while the browser showed another, and Enter switched it again.
  state = {
    ...screenState(),
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example Domain",
        active: true,
      },
      {
        id: "tab-2",
        url: "https://docs.example.com/",
        title: "Docs",
        active: false,
      },
      {
        id: "tab-3",
        url: "https://mail.example.com/",
        title: "Mail",
        active: false,
      },
    ],
  };
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  const [first] = within(
    await view.findByRole("tablist", { name: "Tabs" }),
  ).getAllByRole("tab");
  first?.focus();
  await user.keyboard("{Delete}");
  await waitFor(() =>
    expect(
      within(view.getByRole("tablist", { name: "Tabs" }))
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Docs", "Mail"]),
  );
  const mail = view.getByRole("tab", { name: "Mail" });
  await waitFor(() => expect(document.activeElement).toBe(mail));
  expect(mail.getAttribute("aria-selected")).toBe("true");
  expect(mail.getAttribute("tabindex")).toBe("0");

  // Delete on a tab that does not show leaves the one that does, and the focus goes to its neighbour.
  view.getByRole("tab", { name: "Docs" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(document.activeElement).toBe(mail));
});

test("a browser that stops answering is said to, where it would be shown, and comes back by itself once it answers", async () => {
  // The end-to-end run: the person's browser stopped answering, and the page went blank with nothing said.
  state = screenState();
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  await view.findByLabelText(SCREEN);
  state = {
    ...screenState(),
    open: false,
    tabs: [],
    problem: NOT_ANSWERING,
  };
  // The next of the page's reads, which it makes every second.
  await act(() => queryClient.invalidateQueries());
  expect(await view.findByText(NOT_ANSWERING)).toBeTruthy();
  // Not "closed", and nothing to open: opening it again would wait on the same browser.
  expect(view.queryByText("Your browser is closed.")).toBeNull();
  expect(view.queryByRole("button", { name: "Open it again" })).toBeNull();
  state = screenState();
  await act(() => queryClient.invalidateQueries());
  expect(await view.findByLabelText(SCREEN)).toBeTruthy();
  await waitFor(() => expect(view.queryByText(NOT_ANSWERING)).toBeNull());
});

test("arriving while the browser is not answering, the page says so rather than staying empty", async () => {
  state = { ...screenState(), open: false, tabs: [], problem: NOT_ANSWERING };
  // The open is refused with the same sentence, as the server answers it.
  refusals = { [browserApiPaths.open]: NOT_ANSWERING };
  const view = draw(<BrowserPage />);
  expect(await view.findByText(NOT_ANSWERING)).toBeTruthy();
  expect(view.getAllByText(NOT_ANSWERING)).toHaveLength(1);
  expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("on OpenBot Desktop a window that is not answering says so in its row", async () => {
  state = { ...nativeState(), problem: NOT_ANSWERING };
  const view = draw(<BrowserPage />);
  expect(await view.findByText("Google Chrome")).toBeTruthy();
  expect(view.getByText(NOT_ANSWERING)).toBeTruthy();
  expect(
    view.queryByText("Open in its own window on your desktop."),
  ).toBeNull();
});

test("while the browser opens, the page shows no loading placeholder, then the browser itself", async () => {
  // The data-access rule: no loading text, spinner or skeleton; what arrives is the answer.
  let launched = () => {};
  opening = new Promise<void>((resolve) => {
    launched = resolve;
  });
  const view = draw(<BrowserPage />);
  expect(await view.findByRole("heading", { name: "Browser" })).toBeTruthy();
  await waitFor(() => expect(opens()).toBe(1));
  await settleReactWork();
  expect(view.queryByText(/Opening/)).toBeNull();
  expect(view.queryByRole("status")).toBeNull();
  expect(view.queryByText("Google Chrome")).toBeNull();
  launched();
  expect(await view.findByText("Google Chrome")).toBeTruthy();
});

test("where OpenBot cannot run a browser for the person, the page says so and opens nothing", async () => {
  state = { ...nativeState(), available: false, open: false };
  const view = draw(<BrowserPage />);
  expect(
    await view.findByText(
      "OpenBot isn't set up to run a browser for you. Ask an admin.",
    ),
  ).toBeTruthy();
  expect(opens()).toBe(0);
});

test("on hosted OpenBot a new tab takes the focus into its address bar, as Chrome does", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  tabsOpen = true;
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "New tab" }));
  await waitFor(() =>
    expect(
      view.getAllByRole("tab").map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["false", "false", "true"]),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("textbox", { name: "Address" }),
    ),
  );
});

test("on hosted OpenBot narration the person turned off stays off after a reload, kept on their account", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  installChrome();
  const view = draw(<BrowserPage />);
  const user = userEvent.setup({ document });
  const toggle = await view.findByRole("switch", { name: "Narration" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await user.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  // Kept as the person's own preference, which every browser they open OpenBot in reads, not in this browser alone.
  await waitFor(() =>
    expect(preferenceWrites().map((write) => write.body)).toEqual([
      { narration: "off" },
    ]),
  );

  // A reload starts from nothing but what the server keeps.
  cleanup();
  queryClient.clear();
  const reloaded = draw(<BrowserPage />);
  const again = await reloaded.findByRole("switch", { name: "Narration" });
  await settleReactWork();
  expect(again.getAttribute("aria-checked")).toBe("false");
  // On again is kept the same way.
  await user.click(again);
  await waitFor(() =>
    expect(preferenceWrites().map((write) => write.body)).toEqual([
      { narration: "off" },
      { narration: "on" },
    ]),
  );
  cleanup();
  queryClient.clear();
  const view3 = draw(<BrowserPage />);
  const third = await view3.findByRole("switch", { name: "Narration" });
  await waitFor(() => expect(third.getAttribute("aria-checked")).toBe("true"));
});

test("where the server says why there is no browser of the person's own, the page says that instead", async () => {
  // Every Bot shares one computer here, which is no place for a person's browser: a Bot's shell there could read the
  // cookies in its profile (server/src/browser/host.ts).
  const why =
    "This OpenBot can't open a browser of your own, because its Bots share one computer.";
  state = { ...screenState(), available: false, open: false, note: why };
  const view = draw(<BrowserPage />);
  expect(await view.findByText(why)).toBeTruthy();
  expect(opens()).toBe(0);
});

test("on OpenBot Desktop with no Chrome or Edge it can open, the browser in the page says why", async () => {
  // Chrome installed only as a Flatpak, which used to be said only in Desktop's log.
  const why =
    "OpenBot can't open the Flatpak version of Google Chrome, so install Chrome from google.com/chrome to use your own browser.";
  state = { ...screenState(), note: why };
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  await view.findByLabelText(SCREEN);
  expect(view.getByText(why)).toBeTruthy();
});

/**
 * Chrome's speech recognition where it cannot hear the person: each recognition started while `error` is set fails
 * with it and then ends, as Chrome does for a microphone it may not use (`not-allowed`), none at all
 * (`audio-capture`), or a speech service it cannot reach (`network`). With no `error` it listens, and `listening`
 * counts the recognitions that did.
 */
function installRefusingChrome(onDevice: OnDeviceModel = everyLanguage()) {
  const chrome: { error: string | null; listening: number } = {
    error: null,
    listening: 0,
  };
  class RefusingRecognition implements Recognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    onstart: Recognition["onstart"] = null;
    onresult: Recognition["onresult"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;
    #starting: ReturnType<typeof setTimeout> | undefined;
    start() {
      const error = chrome.error;
      this.#starting = setTimeout(() => {
        if (error) {
          this.onerror?.({ error });
          this.onend?.();
          return;
        }
        chrome.listening += 1;
        this.onstart?.();
      }, 0);
    }
    stop() {
      clearTimeout(this.#starting);
      queueMicrotask(() => this.onend?.());
    }
    abort() {
      clearTimeout(this.#starting);
      queueMicrotask(() => this.onend?.());
    }
  }
  speechGlobals.SpeechRecognition = speechGlobals.webkitSpeechRecognition =
    withOnDevice(RefusingRecognition, onDevice);
  return chrome;
}

test("on hosted OpenBot Clear browser data asks first in one sentence, Cancel does nothing, and Clear shows the browser fresh", async () => {
  state = screenState();
  openAnswer = answerFor("screen");
  const view = draw(<BrowserPage />);
  await view.findByLabelText(SCREEN);
  const user = userEvent.setup({ document });
  const clears = () =>
    writes.filter((write) => write.path === browserApiPaths.clear);
  const tabNames = () =>
    within(view.getByRole("tablist", { name: "Tabs" }))
      .getAllByRole("tab")
      .map((tab) => tab.textContent);

  await user.click(view.getByRole("button", { name: "Clear browser data" }));
  const confirm = within(
    await view.findByRole("dialog", { name: "Clear this browser?" }),
  );
  expect(
    confirm.getByText(
      "Cookies, saved passwords and history are wiped. You'll have to sign in everywhere again.",
    ),
  ).toBeTruthy();
  await user.click(confirm.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "Clear this browser?" }),
    ).toBeNull(),
  );
  expect(clears()).toEqual([]);
  expect(tabNames()).toEqual(["Example Domain", "New tab"]);

  await user.click(view.getByRole("button", { name: "Clear browser data" }));
  await user.click(
    within(
      await view.findByRole("dialog", { name: "Clear this browser?" }),
    ).getByRole("button", { name: "Clear" }),
  );
  await waitFor(() => expect(tabNames()).toEqual(["New tab"]));
  // One POST, with no body: the route takes none.
  expect(
    clears().map((write) => [write.method, write.body !== undefined]),
  ).toEqual([["POST", false]]);
  expect(
    view.queryByRole("dialog", { name: "Clear this browser?" }),
  ).toBeNull();
  expect(
    (view.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value,
  ).toBe("");
  await waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-slot=toast]")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Browser cleared"]),
  );
  toast.close();
});
