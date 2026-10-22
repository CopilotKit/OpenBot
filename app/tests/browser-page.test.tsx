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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { BrowserPage } from "@/components/browser/browser-page";
import type { Recognition } from "@/lib/browser/narration";
import { queryClient } from "@/query-client";
import {
  isResult,
  STOPPED_MID_PHRASE,
  speechEvent,
} from "./browser-narration.fixture";
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
  if (path === browserApiPaths.state && method === "GET") {
    if (stateFails)
      return Response.json({ error: "Unavailable" }, { status: 500 });
    return Response.json(state);
  }
  if (path === browserApiPaths.open && method === "POST") {
    if (body !== undefined) return refuse();
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
    return browserTabsRequestSchema.safeParse(body).success
      ? Response.json(state)
      : refuse();
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

/** Drawn as the app draws it: strict mode, the app's one query client, a router. */
function draw(ui: ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => ui }),
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
  expect(view.getByText(/The Recorder hears your microphone/)).toBeTruthy();
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
        ? "Look up Ada LovelaceNothing was recorded. The Recorder records your clicks, typing and the pages you open on websites, in every tab you use while it records."
        : "Nothing was recorded in “Look up Ada Lovelace”. The Recorder records your clicks, typing and the pages you open on websites, in every tab you use while it records.",
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
          ? "Look up Ada LovelaceNothing was recorded. The Recorder records your clicks, typing and the pages you open on websites, in every tab you use while it records."
          : "Nothing was recorded in “Look up Ada Lovelace”. The Recorder records your clicks, typing and the pages you open on websites, in every tab you use while it records.",
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
  const screen = await view.findByLabelText(
    "Your browser. Click and type here.",
  );
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
  const address = view.getByRole("textbox", { name: "Address" });
  expect((address as HTMLInputElement).value).toBe("https://example.com/");

  const user = userEvent.setup({ document });
  if (second) await user.click(second);
  await user.click(view.getByRole("button", { name: "New tab" }));
  await user.click(view.getByRole("button", { name: "Close Example Domain" }));
  await user.click(view.getByRole("button", { name: "Back" }));
  await user.click(view.getByRole("button", { name: "Reload" }));
  await user.clear(address);
  await user.type(address, "openbot.ai{Enter}");
  await user.type(address, "how to file an expense report{Enter}");
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
    // Before a recording narration is on, as nothing has failed yet.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
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
  await user.click(
    await view.findByRole("button", { name: "Close Example Domain" }),
  );
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
  expect(
    await view.findByText(
      "On. The Recorder hears your microphone while you record, so say what you're doing as you go.",
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

/**
 * Chrome's speech recognition, as `webkitSpeechRecognition`: once listening it sends what Chrome sent in the recorded
 * run up to the moment Stop was pressed, and on stop() what it sent after, the final phrase then the end. One stopped
 * before it heard anything (as strict mode's first, discarded effect is) just ends, as Chrome's does.
 */
function installChrome() {
  const recognitions: ChromeRecognition[] = [];
  const stopAt =
    STOPPED_MID_PHRASE.find((event) => event.type === "stop")?.at ?? 0;
  const before = STOPPED_MID_PHRASE.filter(isResult).filter(
    (event) => event.at < stopAt,
  );
  const after = STOPPED_MID_PHRASE.filter(isResult).filter(
    (event) => event.at > stopAt,
  );
  class ChromeRecognition implements Recognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    onstart: Recognition["onstart"] = null;
    onresult: Recognition["onresult"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;
    started = false;
    heard = false;
    #listening: ReturnType<typeof setTimeout> | undefined;
    constructor() {
      recognitions.push(this);
    }
    start() {
      this.started = true;
      this.#listening = setTimeout(() => {
        this.onstart?.();
        for (const event of before) this.onresult?.(speechEvent(event));
        this.heard = true;
      }, 0);
    }
    stop() {
      clearTimeout(this.#listening);
      queueMicrotask(() => {
        if (this.heard)
          for (const event of after) this.onresult?.(speechEvent(event));
        this.onend?.();
      });
    }
    abort() {
      clearTimeout(this.#listening);
      queueMicrotask(() => this.onend?.());
    }
  }
  speechGlobals.webkitSpeechRecognition = ChromeRecognition;
  return recognitions;
}

/**
 * Chrome's speech recognition where it cannot hear the person: each recognition started while `error` is set fails
 * with it and then ends, as Chrome does for a microphone it may not use (`not-allowed`), none at all
 * (`audio-capture`), or a speech service it cannot reach (`network`). With no `error` it listens, and `listening`
 * counts the recognitions that did.
 */
function installRefusingChrome() {
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
  speechGlobals.webkitSpeechRecognition = RefusingRecognition;
  return chrome;
}
