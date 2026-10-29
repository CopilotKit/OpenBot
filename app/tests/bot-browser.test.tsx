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
  type BotBrowserApiState,
  type BotBrowserState,
  botBrowserApiPaths,
} from "@openbot/shared/bot-browser";
import type { ComputerControlState } from "@openbot/shared/computer-control";
import {
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  type LauncherState,
} from "@openbot/shared/openbot-browser";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerView } from "@/components/computer/computer-view";
import { Toaster, toast } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import { installChrome } from "./browser-narration.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's screen, opened full size, against the server's routes for a Bot's browser as `shared/bot-browser.ts` defines
 * them. Those routes are another slice's work, so they are stood in for here, answering as the contract says the server
 * does: every body the screen sends is parsed with the contract's own schemas, `mine` is whether the signed-in person
 * holds the wheel (`heldBy`, which the server sets on a take), a write by anyone else is refused with 409, and handing
 * the wheel back ends the person's recording as the computer does.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  originalDecode = HTMLImageElement.prototype.decode;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const ME = "user-me";
const SOMEONE = "user-someone";
const SINCE = "2026-10-27T09:00:00.000Z";

/** A Bot per test: what the screen remembers of a person's recordings is kept per Bot, outside any component. */
let bots = 0;
let botId = "";
let control: ComputerControlState;
let browser: BotBrowserState;
type Request = { path: string; method: string; body: unknown };
const requests: Request[] = [];
/** The person's actions the Recorder has counted by the read after Record. */
let actionsAfterStart = 7;
/** Phrases the page passed the Recorder in the recording now running. */
let phrasesPassed = 0;
/** The person's narration choice as their account keeps it: on, as for someone who chose it, unless a test says. */
let narrationChoice: "on" | "off" | null = "on";
/** What the server says in place of Record where every Bot shares one computer; unset where Record can run. */
let recordRefused: string | undefined;

function idle(extra?: Partial<LauncherState>): LauncherState {
  return {
    connected: false,
    phase: "idle",
    actions: 0,
    narration: "external",
    ...extra,
  };
}

/**
 * A request for the wheel, as the computer records one (`agent-computer/src/control.ts`): a person's own take is
 * `manual`, carrying the words the app asks with; a request the Bot raised is `model`.
 */
const request = (
  status: "waiting" | "taken" | "completed",
  source: "manual" | "model" = "manual",
  reason = "I want to take control of the browser.",
) => ({
  id: "request-1",
  reason,
  source,
  status,
  createdAt: SINCE,
  updatedAt: SINCE,
  expiresAt: "2026-10-27T09:10:00.000Z",
});

function heldBy(person: string | null): ComputerControlState {
  return {
    holder: person ? "human" : "bot",
    since: SINCE,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    // A person's own take, as the app asks for one: its reason is the app's words, not the Bot's.
    ...(person
      ? {
          heldBy: person,
          reason: "I want to take control of the browser.",
          request: request("taken"),
        }
      : {}),
  };
}

/** What the server answers for the signed-in person: the computer's state plus its two verdicts on them. */
function answer(): BotBrowserApiState {
  return {
    ...browser,
    mine: control.holder === "human" && control.heldBy === ME,
    recordingIsMine: browser.recordingBy === ME,
    ...(recordRefused ? { recordRefused } : {}),
  };
}

/** The computer ending a running recording, as it does on Stop and the moment the wheel leaves the person recording. */
function endRecording() {
  const recorder = browser.recorder;
  if (!recorder || recorder.phase === "idle") return;
  const { recordingBy: by, ...rest } = browser;
  browser = {
    ...rest,
    ...(by ? { lastStoppedBy: by } : {}),
    recorder: idle({
      lastStopped: {
        recordingId: recorder.recordingId ?? "rec",
        title: recorder.title ?? "",
        stoppedAt: Date.now(),
        actions: recorder.actions,
        phrases: phrasesPassed,
      },
    }),
  };
}

const conflict = (error: string) => Response.json({ error }, { status: 409 });
const invalid = () =>
  Response.json({ error: "Invalid request" }, { status: 400 });

async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, body });
  const computer = `/api/computers/${encodeURIComponent(botId)}`;
  const mine = answer().mine;

  if (path === "/api/me")
    return Response.json({
      user: { id: ME, email: "me@example.com", role: "user", onboarding: null },
    });
  if (path === "/api/settings/preferences") {
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
  if (path === `${computer}/control`) return Response.json(control);
  if (path === `${computer}/control/request`) {
    // As the computer answers: the source the caller gave (the app's take says `manual`), else the Bot's.
    const asked = body as { reason?: string; source?: "manual" | "model" };
    const raised = request("waiting", asked.source ?? "model", asked.reason);
    control = {
      ...control,
      requested: true,
      reason: raised.reason,
      request: raised,
    };
    return Response.json(control);
  }
  if (path === `${computer}/control/take`) {
    // The server always sends the computer who took it. The request taken is the one raised, source and all.
    const raised = control.request;
    control = {
      ...heldBy(ME),
      ...(raised
        ? {
            reason: raised.reason,
            request: { ...raised, status: "taken" as const },
          }
        : {}),
    };
    return Response.json(control);
  }
  if (path === `${computer}/control/release`) {
    if (browser.recordingBy === control.heldBy) endRecording();
    control = { ...heldBy(null), request: request("completed") };
    return Response.json(control);
  }
  if (path === `${computer}/screenshot`)
    return Response.json({
      base64: "AAAA",
      width: 1280,
      height: 800,
      capturedAt: SINCE,
      url: "https://expenses.example/report",
    });
  if (path === `${computer}/status`)
    return Response.json({ botId, state: "ready" });

  if (path === botBrowserApiPaths.state(botId) && method === "GET")
    return Response.json(answer());
  if (path === botBrowserApiPaths.tabs(botId)) {
    const asked = browserTabsRequestSchema.safeParse(body);
    if (!asked.success) return invalid();
    if (!mine) return conflict("Take control of the Bot's browser first.");
    // A close, as the computer makes one: the tab goes, and when it was the one in front the newest tab comes forward
    // (agent-computer's profiles.ts, `retarget`). An activate brings the tab forward.
    if (asked.data.action === "close") {
      const closing = asked.data.tabId;
      const left = browser.tabs.filter((tab) => tab.id !== closing);
      const front = browser.tabs.find((tab) => tab.id === closing)?.active
        ? left.at(-1)?.id
        : left.find((tab) => tab.active)?.id;
      browser = {
        ...browser,
        tabs: left.map((tab) => ({ ...tab, active: tab.id === front })),
      };
    } else if (asked.data.action === "activate") {
      const front = asked.data.tabId;
      browser = {
        ...browser,
        tabs: browser.tabs.map((tab) => ({ ...tab, active: tab.id === front })),
      };
    }
    // A new tab opens empty, in front, as the computer opens one.
    else if (asked.data.action === "new")
      browser = {
        ...browser,
        tabs: [
          ...browser.tabs.map((tab) => ({ ...tab, active: false })),
          {
            id: `tab-${browser.tabs.length + 1}`,
            url: "about:blank",
            title: "about:blank",
            active: true,
          },
        ],
      };
    return Response.json(answer());
  }
  if (path === botBrowserApiPaths.navigate(botId)) {
    if (!browserNavigateRequestSchema.safeParse(body).success) return invalid();
    return mine
      ? Response.json(answer())
      : conflict("Take control of the Bot's browser first.");
  }
  if (path === botBrowserApiPaths.recording(botId)) {
    const asked = browserRecordingRequestSchema.safeParse(body);
    if (!asked.success) return invalid();
    if (asked.data.action === "start") {
      if (!mine) return conflict("Take control of the Bot's browser first.");
      phrasesPassed = 0;
      browser = {
        ...browser,
        recordingBy: ME,
        recorder: {
          ...idle(),
          connected: true,
          phase: "recording",
          recordingId: `rec-${botId}`,
          title: asked.data.title,
          // As if the person had been at it for 42 seconds by the next read.
          startedAt: Date.now() - 42_000,
          actions: actionsAfterStart,
        },
      };
      return Response.json(answer());
    }
    if (browser.recordingBy !== ME)
      return conflict("No recording of yours is running.");
    endRecording();
    return Response.json(answer());
  }
  if (path === botBrowserApiPaths.clear(botId) && method === "POST") {
    if (body !== undefined) return invalid();
    if (!mine) return conflict("Take control of the Bot's browser first.");
    // As the computer clears it: a recording there ends, the profile goes, and the browser starts again with one empty
    // tab and nothing in it, the wheel still the person's.
    endRecording();
    browser = {
      open: true,
      recorder: idle(),
      tabs: [
        {
          id: "tab-fresh",
          url: "about:blank",
          title: "about:blank",
          active: true,
        },
      ],
    };
    return Response.json(answer());
  }
  if (path === botBrowserApiPaths.narration(botId)) {
    if (!browserNarrationRequestSchema.safeParse(body).success)
      return invalid();
    if (browser.recordingBy !== ME)
      return conflict("No recording of yours is running.");
    if ("text" in body) phrasesPassed += 1;
    return Response.json({ ok: true });
  }
  return new Response(null, { status: 404 });
}

/** Whether the live screen's socket opens, for a case about where the keyboard goes; otherwise nothing answers it. */
let socketsOpen = false;
/** What the open live screen sent the Bot's browser. */
const screenSent: { type: string; event?: string; key?: string }[] = [];

/** The live screen's socket, which nothing here answers unless a case opens it: the screen under the bar is not what
 * most of these cases are about. */
class QuietSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    if (!socketsOpen) return;
    this.readyState = QuietSocket.OPEN;
    queueMicrotask(() => this.onopen?.());
  }
  send(payload: string) {
    screenSent.push(JSON.parse(payload));
  }
  close() {}
}

const originalFetch = global.fetch;
const originalSocket = globalThis.WebSocket;
// Read once a DOM exists: this module is evaluated before `beforeAll` registers one.
let originalDecode: typeof HTMLImageElement.prototype.decode;
const speechGlobals = globalThis as {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

beforeEach(() => {
  queryClient.clear();
  bots += 1;
  botId = `sales-${bots}`;
  requests.length = 0;
  actionsAfterStart = 7;
  phrasesPassed = 0;
  narrationChoice = "on";
  recordRefused = undefined;
  socketsOpen = false;
  screenSent.length = 0;
  control = heldBy(null);
  browser = {
    open: true,
    recorder: idle(),
    tabs: [
      {
        id: "tab-1",
        url: "https://expenses.example/report",
        title: "Expense report",
        active: true,
      },
      {
        id: "tab-2",
        url: "https://docs.example/policy",
        title: "Travel policy",
        active: false,
      },
    ],
  };
  global.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      server(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  HTMLImageElement.prototype.decode = () => Promise.resolve();
  delete speechGlobals.SpeechRecognition;
  delete speechGlobals.webkitSpeechRecognition;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  HTMLImageElement.prototype.decode = originalDecode;
  delete speechGlobals.SpeechRecognition;
  delete speechGlobals.webkitSpeechRecognition;
});

/** The Bot's screen in a conversation, drawn as the app draws it (its toasts with it), opened full size as a person
 * opens it. */
async function openScreen() {
  const view = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ComputerView computerId={botId} name="Sales" />
        <Toaster />
      </QueryClientProvider>
    </StrictMode>,
  );
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("button", { name: "Open the Bot's screen full size" }),
  );
  const dialog = within(
    await view.findByRole("dialog", { name: "The Bot's screen" }),
  );
  await dialog.findByRole("tablist", { name: "Tabs" });
  return { view, dialog, user };
}

const writes = () =>
  requests.filter(
    (sent) =>
      sent.method === "POST" &&
      sent.path.startsWith(`${botBrowserApiPaths.state(botId)}/`),
  );
const address = (dialog: ReturnType<typeof within>) =>
  dialog.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
const disabled = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled;
const preferenceWrites = () =>
  requests.filter(
    (sent) =>
      sent.path === "/api/settings/preferences" && sent.method === "PATCH",
  );

test("while the Bot holds the wheel the bar shows where the Bot is, read only, and Record asks for control", async () => {
  const { dialog, user } = await openScreen();

  const [first, second] = dialog.getAllByRole("tab");
  expect(first?.textContent).toBe("Expense report");
  expect(first?.getAttribute("aria-selected")).toBe("true");
  expect(second?.textContent).toBe("Travel policy");
  // Where the Bot is, legible rather than faded, and not for typing into.
  expect(address(dialog).value).toBe("https://expenses.example/report");
  expect(address(dialog).readOnly).toBe(true);
  expect(address(dialog).disabled).toBe(false);
  for (const name of ["Back", "Forward", "Reload", "New tab"])
    expect(disabled(dialog.getByRole("button", { name }))).toBe(true);
  // The mouse's close button, which is outside the accessibility tree (the tab's Delete is its keyboard way).
  expect(disabled(dialog.getByTitle("Close Expense report"))).toBe(true);
  expect(disabled(second as HTMLElement)).toBe(true);

  // Record is the person's alone, so it waits for the wheel, and says so.
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  expect(disabled(dialog.getByRole("button", { name: "Record" }))).toBe(true);
  expect(dialog.getByText("Take control to record.")).toBeTruthy();
  expect(dialog.queryByRole("switch", { name: "Narration" })).toBeNull();

  // The Bot moves on: the bar follows it.
  browser = {
    ...browser,
    tabs: [
      {
        id: "tab-1",
        url: "https://expenses.example/receipts",
        title: "Receipts",
        active: true,
      },
    ],
  };
  await queryClient.invalidateQueries();
  await waitFor(() =>
    expect(address(dialog).value).toBe("https://expenses.example/receipts"),
  );
  expect(writes()).toEqual([]);
});

test("where the Bots share one computer, the screen says why it cannot record, and offers no Record, while the bar still works", async () => {
  recordRefused =
    "This OpenBot can't record in a Bot's browser, because its Bots share one computer.";
  control = heldBy(ME);
  const { dialog } = await openScreen();
  const panel = within(dialog.getByRole("region", { name: "Record a task" }));
  expect(panel.getByText("Recording isn't available here")).toBeTruthy();
  expect(panel.getByText(recordRefused)).toBeTruthy();
  expect(panel.queryByRole("button", { name: "Record" })).toBeNull();
  expect(panel.queryByRole("textbox", { name: "Task name" })).toBeNull();
  expect(panel.queryByRole("switch", { name: "Narration" })).toBeNull();
  // The bar is the person's while they hold the wheel, as anywhere else.
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  expect(writes()).toEqual([]);
});

test("taking control makes the bar live at once, and it works the Bot's browser through the Bot's own routes", async () => {
  const { dialog, user } = await openScreen();
  await user.click(dialog.getByRole("button", { name: "Take control" }));
  // Read again as the wheel changes hands, not on the next once-a-second read.
  await waitFor(() => expect(address(dialog).readOnly).toBe(false), {
    timeout: 900,
  });

  const [, second] = dialog.getAllByRole("tab");
  if (second) await user.click(second);
  await user.click(dialog.getByRole("button", { name: "New tab" }));
  await user.click(dialog.getByTitle("Close Expense report"));
  await user.click(dialog.getByRole("button", { name: "Back" }));
  await user.click(dialog.getByRole("button", { name: "Forward" }));
  await user.click(dialog.getByRole("button", { name: "Reload" }));
  await user.clear(address(dialog));
  await user.type(address(dialog), "openbot.ai{Enter}");

  await waitFor(() =>
    expect(writes()).toEqual([
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "activate", tabId: "tab-2" },
      },
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "new" },
      },
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "close", tabId: "tab-1" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { action: "back" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { action: "forward" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { action: "reload" },
      },
      {
        path: botBrowserApiPaths.navigate(botId),
        method: "POST",
        body: { url: "https://openbot.ai" },
      },
    ]),
  );
  expect(dialog.queryByRole("alert")).toBeNull();
});

test("Record names the task, runs while the person holds the wheel, and Stop says it went to their Learning space", async () => {
  control = heldBy(ME);
  const { dialog, user } = await openScreen();
  const record = dialog.getByRole("button", { name: "Record" });
  expect(disabled(record)).toBe(true);
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await user.click(record);
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        path: botBrowserApiPaths.recording(botId),
        method: "POST",
        body: {
          action: "start",
          title: "Submit the taxi receipt",
          language: navigator.language,
        },
      },
    ]),
  );
  expect(
    (await dialog.findByRole("timer")).textContent?.match(
      /^0:4\d · 7 actions$/,
    ),
  ).toBeTruthy();
  expect(dialog.getByText("Submit the taxi receipt")).toBeTruthy();

  await user.click(dialog.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.recording(botId),
      method: "POST",
      body: { action: "stop" },
    }),
  );
  await waitFor(() =>
    expect(
      dialog
        .getAllByRole("status")
        .map((status) => status.textContent)
        .find((text) => text?.includes("Saved")),
    ).toBe("Submit the taxi receiptSaved to your Learning space: 7 actions."),
  );
  expect(dialog.getByRole("textbox", { name: "Task name" })).toBeTruthy();
  expect(dialog.queryByRole("alert")).toBeNull();
});

test("narration goes to the Bot's browser, and Stop hands over the phrase being said before the recording ends", async () => {
  control = heldBy(ME);
  const recognitions = installChrome();
  const { dialog, user } = await openScreen();
  await waitFor(() =>
    expect(
      dialog
        .getByRole("switch", { name: "Narration" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await user.click(dialog.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));
  await user.click(dialog.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(writes().at(-1)?.body).toEqual({ action: "stop" }),
  );

  const narration = writes().filter(
    (sent) => sent.path === botBrowserApiPaths.narration(botId),
  );
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
  // Nothing went to the person's own browser.
  expect(requests.some((sent) => sent.path.startsWith("/api/browser"))).toBe(
    false,
  );
  expect(
    await dialog.findByText(
      "Saved to your Learning space: 7 actions and 1 narrated phrase.",
    ),
  ).toBeTruthy();
});

test("handing the wheel back while recording ends the recording, said as an ending rather than an error", async () => {
  control = heldBy(ME);
  actionsAfterStart = 3;
  const { dialog, user } = await openScreen();
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await user.click(dialog.getByRole("button", { name: "Record" }));
  await dialog.findByRole("timer");

  await user.click(dialog.getByRole("button", { name: "Hand back" }));
  await waitFor(() =>
    expect(
      dialog
        .getAllByRole("status")
        .map((status) => status.textContent)
        .find((text) => text?.includes("Saved")),
    ).toBe(
      "Submit the taxi receiptThe recording ended when control went back to the Bot. Saved to your Learning space: 3 actions.",
    ),
  );
  expect(dialog.queryByRole("alert")).toBeNull();
  expect(dialog.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(dialog.getByText("Take control to record.")).toBeTruthy();
  // The person never pressed Stop: the computer ended it.
  expect(
    writes().filter(
      (sent) => (sent.body as { action?: string }).action === "stop",
    ),
  ).toEqual([]);
});

test("a phrase cut off as the wheel goes back is not still reported as lost when the person takes the wheel again", async () => {
  control = heldBy(ME);
  const recognitions = installChrome();
  const { dialog, user } = await openScreen();
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await user.click(dialog.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));

  // Mid-phrase: the phrase arrives after the computer has ended the recording, and is refused.
  await user.click(dialog.getByRole("button", { name: "Hand back" }));
  await waitFor(() =>
    expect(
      requests.some(
        (sent) =>
          sent.path === botBrowserApiPaths.narration(botId) &&
          "text" in (sent.body as object),
      ),
    ).toBe(true),
  );
  await dialog.findByText(/The recording ended when control went back/);

  await user.click(dialog.getByRole("button", { name: "Take control" }));
  await dialog.findByRole("switch", { name: "Narration" });
  expect(dialog.queryByText(/didn't reach the Recorder/)).toBeNull();
  expect(dialog.queryByRole("alert")).toBeNull();
});

test("another person's recording is said only to be running, and is never called saved to this person's Learning space", async () => {
  control = heldBy(SOMEONE);
  browser = {
    ...browser,
    recordingBy: SOMEONE,
    recorder: {
      ...idle(),
      connected: true,
      phase: "recording",
      recordingId: "rec-theirs",
      title: "Pay the vendor",
      startedAt: Date.now() - 5_000,
      actions: 2,
    },
  };
  const { dialog } = await openScreen();
  expect(await dialog.findByText("Someone is recording")).toBeTruthy();
  expect(dialog.queryByText(/Pay the vendor/)).toBeNull();
  expect(dialog.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(dialog.queryByRole("timer")).toBeNull();

  // They stop. What their recording held is theirs to be told, not this person.
  endRecording();
  await queryClient.invalidateQueries();
  expect(
    await dialog.findByRole("textbox", { name: "Task name" }),
  ).toBeTruthy();
  expect(dialog.queryByText(/Pay the vendor/)).toBeNull();
  expect(dialog.queryByText(/Saved/)).toBeNull();
});

test("the retired Teach a browser workflow panel is gone, and nothing asks for demonstrations", async () => {
  control = heldBy(ME);
  const { view, dialog } = await openScreen();
  await dialog.findByRole("button", { name: "Record" });
  expect(view.queryByText(/Teach a browser workflow/)).toBeNull();
  expect(view.queryByText(/Record your steps/)).toBeNull();
  expect(
    requests.filter((sent) => sent.path.startsWith("/api/demonstrations")),
  ).toEqual([]);
});

test("after a reload the person is told their last recording went to their Learning space, and never told so of someone else's", async () => {
  // Recordings this page never saw running: it was opened after they had ended.
  for (const [owner, says] of [
    [ME, "Submit the taxi receiptSaved to your Learning space: 4 actions."],
    [SOMEONE, null],
  ] as const) {
    cleanup();
    queryClient.clear();
    bots += 1;
    botId = `sales-${bots}`;
    control = heldBy(null);
    browser = {
      ...browser,
      lastStoppedBy: owner,
      recorder: idle({
        lastStopped: {
          recordingId: `rec-earlier-${bots}`,
          title: "Submit the taxi receipt",
          stoppedAt: Date.now() - 60_000,
          actions: 4,
          phrases: 0,
        },
      }),
    };
    const { dialog } = await openScreen();
    await dialog.findByRole("button", { name: "Record" });
    if (says)
      await waitFor(() =>
        expect(
          dialog
            .getAllByRole("status")
            .map((status) => status.textContent)
            .find((text) => text?.includes("Saved")),
        ).toBe(says),
      );
    else {
      // Read twice, so the answer is not the moment before the first read arrived.
      await queryClient.invalidateQueries();
      await settleReactWork();
      expect(dialog.queryByText(/Saved/)).toBeNull();
      expect(dialog.queryByText(/Submit the taxi receipt/)).toBeNull();
    }
  }
});

test("when someone else holds the wheel the row says so, offers no Hand back, and the screen takes nothing from this person", async () => {
  control = heldBy(SOMEONE);
  const { view, dialog } = await openScreen();
  // The wheel's row in the view, and Record's sentence under it.
  await waitFor(() =>
    expect(dialog.getAllByText("Someone else has control.").length).toBe(2),
  );
  expect(view.queryByText(/You have control/)).toBeNull();
  expect(view.queryByRole("button", { name: "Hand back" })).toBeNull();
  for (const take of view.getAllByRole("button", { name: "Take control" }))
    expect(disabled(take)).toBe(true);
  // The card under the conversation says the same, and so does Record, which waits for the wheel.
  expect(view.getAllByText("Someone else has control.").length).toBe(3);
  expect(disabled(dialog.getByRole("button", { name: "Record" }))).toBe(true);
  expect(dialog.queryByText("Take control to record.")).toBeNull();
  // Read only: the live screen is not this person's to click and type into.
  expect(view.queryByLabelText(/Click and type here/)).toBeNull();

  // The holder themselves is still told they have it, and may hand it back.
  control = heldBy(ME);
  await waitFor(
    () =>
      expect(dialog.getByRole("button", { name: "Hand back" })).toBeTruthy(),
    { timeout: 3000 },
  );
  expect(dialog.queryByText("Someone else has control.")).toBeNull();
});

test("someone else taking the wheel does not open the Computer for this person or mark it as needing them", async () => {
  control = heldBy(SOMEONE);
  const opened: boolean[] = [];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ComputerChatControls
        computerId={botId}
        open={false}
        onOpenChange={(open) => opened.push(open)}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      requests.some((sent) => sent.path === "/api/me") &&
        requests.some((sent) => sent.path.endsWith("/control")),
    ).toBe(true),
  );
  await settleReactWork();
  expect(view.queryByRole("img", { name: "Needs you" })).toBeNull();
  expect(opened).toEqual([]);
});

test("the wheel's line never echoes the person's own take as a reason, and says the Bot's when the Bot asked", async () => {
  const { dialog, user } = await openScreen();
  const line = () =>
    dialog.getByText(/^You have control\. Click and type on the page\./);

  // The person takes the wheel themselves. The app says it is their take, and the computer records it so.
  await user.click(dialog.getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    expect(line().textContent).toBe(
      "You have control. Click and type on the page.",
    ),
  );
  expect(
    requests.find((sent) => sent.path.endsWith("/control/request"))?.body,
  ).toEqual({
    reason: "I want to take control of the browser.",
    source: "manual",
  });
  expect(dialog.queryByText(/I want to take control/)).toBeNull();
  await user.click(dialog.getByRole("button", { name: "Hand back" }));

  // The Bot asks for the person, as the computer records a Bot's request, and they take the wheel for it: what the
  // Bot asked for is worth repeating.
  control = {
    ...heldBy(null),
    requested: true,
    reason: "Sign in to the bank, then hand back.",
    request: request(
      "waiting",
      "model",
      "Sign in to the bank, then hand back.",
    ),
  };
  await waitFor(
    () => expect(dialog.getByText("The Bot needs you.")).toBeTruthy(),
    { timeout: 3000 },
  );
  await user.click(dialog.getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    expect(line().textContent).toBe(
      "You have control. Click and type on the page. Sign in to the bank, then hand back.",
    ),
  );
});

test("a new tab takes the focus into its address bar, as Chrome does", async () => {
  control = heldBy(ME);
  const { dialog, user } = await openScreen();
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  await user.click(dialog.getByRole("button", { name: "New tab" }));
  await waitFor(() =>
    expect(
      dialog
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["false", "false", "true"]),
  );
  await waitFor(() => expect(document.activeElement).toBe(address(dialog)));
  // What the person types goes to the address, not to the Bot's page.
  await user.keyboard("openbot.ai{Enter}");
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.navigate(botId),
      method: "POST",
      body: { url: "https://openbot.ai" },
    }),
  );
});

test("narration the person turned off stays off when they open the Bot's screen again or reload, kept on their account", async () => {
  control = heldBy(ME);
  const recognitions = installChrome();
  const first = await openScreen();
  const toggle = await first.dialog.findByRole("switch", { name: "Narration" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await first.user.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  // The account's preference, which the Browser page reads too, rather than anything this browser keeps.
  await waitFor(() =>
    expect(preferenceWrites().map((sent) => sent.body)).toEqual([
      { narration: "off" },
    ]),
  );

  // Closed and opened again, as on a reload: the page starts from nothing but what the server keeps.
  cleanup();
  queryClient.clear();
  const again = await openScreen();
  const reloaded = await again.dialog.findByRole("switch", {
    name: "Narration",
  });
  await settleReactWork();
  expect(reloaded.getAttribute("aria-checked")).toBe("false");
  // A recording started now asks nothing, since they answered, and is not heard.
  await again.user.type(
    again.dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await again.user.click(again.dialog.getByRole("button", { name: "Record" }));
  await again.dialog.findByRole("timer");
  await settleReactWork();
  expect(again.view.queryByRole("dialog", { name: /Narrate/ })).toBeNull();
  expect(recognitions.filter((recognition) => recognition.started)).toEqual([]);
  expect(
    writes().filter(
      (sent) => sent.path === botBrowserApiPaths.narration(botId),
    ),
  ).toEqual([]);
});

test("Record on a Bot's screen asks whether to narrate before the person's first recording, and a yes listens on their computer", async () => {
  narrationChoice = null;
  control = heldBy(ME);
  const recognitions = installChrome();
  const { view, dialog, user } = await openScreen();
  // Nobody chose yet: the row says the microphone stays closed, and nothing listens.
  expect(
    await dialog.findByText(
      "Not chosen yet. Record asks before your first recording, and the microphone stays closed until you say yes.",
    ),
  ).toBeTruthy();
  expect(
    dialog
      .getByRole("switch", { name: "Narration" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await user.click(dialog.getByRole("button", { name: "Record" }));
  // The same question, and the same answer kept, as the Browser page's.
  const question = await view.findByRole("dialog", {
    name: "Narrate while you record?",
  });
  expect(
    writes().filter(
      (sent) => (sent.body as { action?: string }).action === "start",
    ),
  ).toEqual([]);
  expect(recognitions).toHaveLength(0);
  await user.click(
    within(question).getByRole("button", { name: "Record with narration" }),
  );
  await waitFor(() => expect(recognitions.at(-1)?.heard).toBe(true));
  expect(recognitions.at(-1)?.processLocally).toBe(true);
  expect(preferenceWrites().map((sent) => sent.body)).toEqual([
    { narration: "on" },
  ]);
  expect(
    writes().find(
      (sent) => (sent.body as { action?: string }).action === "start",
    )?.body,
  ).toMatchObject({ title: "Submit the taxi receipt" });
  // An open microphone is said in so many words, and the Bot's screen is still open behind the answered question.
  expect(
    await dialog.findByText("Listening. Say what you're doing as you go."),
  ).toBeTruthy();
  expect(view.queryByRole("dialog", { name: /Narrate/ })).toBeNull();
  expect(view.getByRole("dialog", { name: "The Bot's screen" })).toBeTruthy();
});

test("the Bot's tabs follow the tabs pattern: one Tab stop, arrows, Home and End, Enter to switch, Delete to close", async () => {
  control = heldBy(ME);
  browser = {
    ...browser,
    tabs: [
      ...browser.tabs,
      {
        id: "tab-3",
        url: "https://mail.example/",
        title: "Mail",
        active: false,
      },
    ],
  };
  const { dialog, user } = await openScreen();
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  const [first, second, third] = within(
    dialog.getByRole("tablist", { name: "Tabs" }),
  ).getAllByRole("tab");
  // The tab that shows controls the panel below, which it names: the address bar and the Bot's page are in it.
  const panel = dialog.getByRole("tabpanel", { name: "Expense report" });
  expect(first?.getAttribute("aria-controls")).toBe(panel.id);
  expect(within(panel).getByRole("textbox", { name: "Address" })).toBe(
    address(dialog),
  );
  expect(
    await within(panel).findByLabelText(
      "The Bot's screen. You have control. Click and type here.",
    ),
  ).toBeTruthy();
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
  await user.keyboard("{Home}{ArrowRight}");
  // Moving switches nothing: a switch is a request to the Bot's computer, so it waits for Enter.
  expect(writes()).toEqual([]);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(second?.getAttribute("aria-selected")).toBe("true"),
  );
  // Delete closes it, the tab that shows now: the focus goes to the tab the Bot's browser shows next, its newest.
  await user.keyboard("{Delete}");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      dialog.getByRole("tab", { name: "Mail" }),
    ),
  );
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "activate", tabId: "tab-2" },
      },
      {
        path: botBrowserApiPaths.tabs(botId),
        method: "POST",
        body: { action: "close", tabId: "tab-2" },
      },
    ]),
  );
});

test("while the Bot holds the wheel its tabs take no keys: nothing is switched or closed", async () => {
  const { dialog, user } = await openScreen();
  const [first] = dialog.getAllByRole("tab");
  first?.focus();
  await user.keyboard("{ArrowRight}{Enter}{Delete}");
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("Escape on the narration question closes the question, not the Bot's screen behind it", async () => {
  narrationChoice = null;
  control = heldBy(ME);
  installChrome();
  const { view, dialog, user } = await openScreen();
  await user.type(
    dialog.getByRole("textbox", { name: "Task name" }),
    "Submit the taxi receipt",
  );
  await user.click(dialog.getByRole("button", { name: "Record" }));
  await view.findByRole("dialog", { name: "Narrate while you record?" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: /Narrate/ })).toBeNull(),
  );
  await settleReactWork();
  // Nothing was answered, so nothing records and nothing is kept; the person is still at the Bot's screen.
  expect(view.getByRole("dialog", { name: "The Bot's screen" })).toBeTruthy();
  expect(preferenceWrites()).toEqual([]);
  expect(writes()).toEqual([]);
});

test("taking control gives the Bot's screen the keyboard, and the bar and Record keep their own keys", async () => {
  socketsOpen = true;
  control = heldBy(ME);
  const { dialog, user } = await openScreen();
  const screen = await dialog.findByLabelText(
    "The Bot's screen. You have control. Click and type here.",
  );
  // Opened to drive: the person types into the Bot's page with no click first.
  await waitFor(() => expect(document.activeElement).toBe(screen));
  await user.keyboard("a");
  const keys = () =>
    screenSent
      .filter((sent) => sent.type === "key")
      .map((sent) => `${sent.event}:${sent.key}`);
  expect(keys()).toEqual(["down:a", "up:a"]);

  // The tabs keep the tabs pattern's keys, which never reach the Bot's page.
  const [first, second] = dialog.getAllByRole("tab");
  first?.focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(second as Element);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.tabs(botId),
      method: "POST",
      body: { action: "activate", tabId: "tab-2" },
    }),
  );

  // An address typed in the bar goes there, and the keyboard goes back to the page it opens.
  await user.click(address(dialog));
  await user.keyboard("openbot.ai{Enter}");
  await waitFor(() =>
    expect(writes().at(-1)).toEqual({
      path: botBrowserApiPaths.navigate(botId),
      method: "POST",
      body: { url: "https://openbot.ai" },
    }),
  );
  await waitFor(() => expect(document.activeElement).toBe(screen));

  // Record's task name takes what is typed into it.
  const task = dialog.getByRole("textbox", { name: "Task name" });
  await user.click(task);
  await user.keyboard("Pay");
  expect((task as HTMLInputElement).value).toBe("Pay");
  expect(keys()).toEqual(["down:a", "up:a"]);
});

test("Delete on the Bot's tab that shows puts the focus on the tab the Bot's browser shows next, not on its neighbour", async () => {
  // The computer brings the newest tab forward when the one in front closes, in a Bot's browser as in a person's: the
  // focus goes where the browser says, so Enter on it does not switch the browser again.
  control = heldBy(ME);
  browser = {
    ...browser,
    tabs: [
      ...browser.tabs,
      {
        id: "tab-3",
        url: "https://mail.example/",
        title: "Mail",
        active: false,
      },
    ],
  };
  const { dialog, user } = await openScreen();
  await waitFor(() => expect(address(dialog).readOnly).toBe(false));
  const tabNames = () =>
    within(dialog.getByRole("tablist", { name: "Tabs" }))
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
  dialog.getByRole("tab", { name: "Expense report" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabNames()).toEqual(["Travel policy", "Mail"]));
  const mail = dialog.getByRole("tab", { name: "Mail" });
  await waitFor(() => expect(document.activeElement).toBe(mail));
  expect(mail.getAttribute("aria-selected")).toBe("true");
  expect(mail.getAttribute("tabindex")).toBe("0");

  // Delete on a tab that does not show leaves the one that does, and the focus goes to its neighbour.
  dialog.getByRole("tab", { name: "Travel policy" }).focus();
  await user.keyboard("{Delete}");
  await waitFor(() => expect(tabNames()).toEqual(["Mail"]));
  await waitFor(() => expect(document.activeElement).toBe(mail));
  expect(writes().map((sent) => sent.body)).toEqual([
    { action: "close", tabId: "tab-1" },
    { action: "close", tabId: "tab-2" },
  ]);
});

test("Clear browser data is the wheel holder's: a short confirmation, Cancel does nothing, Clear wipes it and the bar shows the fresh browser", async () => {
  const { view, dialog, user } = await openScreen();
  const button = () =>
    dialog.getByRole("button", { name: "Clear browser data" });
  // Never under the Bot.
  expect(disabled(button())).toBe(true);
  await user.click(dialog.getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(disabled(button())).toBe(false));

  // One question, one sentence, two answers.
  await user.click(button());
  const confirm = within(
    await view.findByRole("dialog", { name: "Clear this browser?" }),
  );
  expect(
    confirm.getByText(
      "Cookies, saved passwords and history are wiped. You'll have to sign in everywhere again.",
    ),
  ).toBeTruthy();
  expect(
    confirm
      .getAllByRole("button")
      .map((each) => each.textContent?.trim())
      .filter(Boolean),
  ).toEqual(["Cancel", "Clear", "Close"]);
  await user.click(confirm.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "Clear this browser?" }),
    ).toBeNull(),
  );
  expect(
    requests.filter((sent) => sent.path === botBrowserApiPaths.clear(botId)),
  ).toEqual([]);
  expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Expense report",
    "Travel policy",
  ]);

  // Clear: the Bot's browser is wiped, the bar shows it fresh, and a toast says so.
  await user.click(button());
  const again = within(
    await view.findByRole("dialog", { name: "Clear this browser?" }),
  );
  await user.click(again.getByRole("button", { name: "Clear" }));
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "Clear this browser?" }),
    ).toBeNull(),
  );
  // One POST, with no body: the route takes none.
  const cleared = requests.filter(
    (sent) => sent.path === botBrowserApiPaths.clear(botId),
  );
  expect(cleared.map((sent) => [sent.method, sent.body !== undefined])).toEqual(
    [["POST", false]],
  );
  await waitFor(() =>
    expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "New tab",
    ]),
  );
  expect(address(dialog).value).toBe("");
  // Still theirs: the bar works the fresh browser.
  expect(address(dialog).readOnly).toBe(false);
  await waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-slot=toast]")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Browser cleared"]),
  );
  // Drawn over the Bot's screen, not behind it: both are fixed layers, and on the same one the screen, opened after the
  // toasts were put in the page, covered the toast (seen in the headless run). Read from the layer each one is given.
  const layer = (element: Element | null) =>
    Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(element?.className ?? "")?.[1]);
  const screenLayer = layer(
    document.querySelector('[role="dialog"][aria-label="The Bot\'s screen"]'),
  );
  expect(screenLayer).toBeGreaterThan(0);
  expect(
    layer(document.querySelector("[data-slot=toast-viewport]")),
  ).toBeGreaterThan(screenLayer);
  toast.close();
});

test("a clear the server refuses says why in the confirmation, and wipes nothing", async () => {
  control = heldBy(ME);
  const { view, dialog, user } = await openScreen();
  const button = dialog.getByRole("button", { name: "Clear browser data" });
  await waitFor(() => expect(disabled(button)).toBe(false));
  await user.click(button);
  // The wheel goes back to the Bot while the question is open.
  control = heldBy(null);
  const confirm = within(
    await view.findByRole("dialog", { name: "Clear this browser?" }),
  );
  await user.click(confirm.getByRole("button", { name: "Clear" }));
  expect((await confirm.findByRole("alert")).textContent).toBe(
    "Take control of the Bot's browser first.",
  );
  // Nothing was wiped: the question closes on Cancel, over the browser as it was.
  await user.click(confirm.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "Clear this browser?" }),
    ).toBeNull(),
  );
  expect(dialog.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Expense report",
    "Travel policy",
  ]);
});
